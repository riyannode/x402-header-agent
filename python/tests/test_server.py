from __future__ import annotations

import base64
import json

import httpx
import pytest

from x402_arc_sdk.client import ARC_TESTNET
from x402_arc_sdk.server import (
    BatchFacilitatorClient,
    PaymentInfo,
    SellerAgent,
    SellerConfig,
)

SELLER = "0x1111111111111111111111111111111111111111"
PAYER = "0x2222222222222222222222222222222222222222"
RESOURCE = "https://seller.example/premium"


def encode_payload(challenge: dict, *, accepted_override: dict | None = None) -> str:
    accepted = json.loads(json.dumps(challenge["accepts"][0]))
    if accepted_override:
        accepted.update(accepted_override)

    authorization = {
        "from": PAYER,
        "to": accepted["payTo"],
        "value": accepted["amount"],
        "validAfter": "0",
        "validBefore": "9999999999",
        "nonce": "0x" + ("11" * 32),
    }
    payload = {
        "x402Version": 2,
        "payload": {
            "authorization": authorization,
            "signature": "0x" + ("22" * 65),
        },
        "resource": challenge["resource"],
        "accepted": accepted,
    }
    return base64.b64encode(json.dumps(payload).encode()).decode()


@pytest.mark.asyncio
async def test_unpaid_request_returns_v2_header_challenge() -> None:
    seller = SellerAgent(SellerConfig(seller_address=SELLER))

    result = await seller.process_request(None, RESOURCE, "$0.001")

    assert result["status"] == 402
    assert "Payment-Required" in result["headers"]
    assert result["body"]["x402Version"] == 2
    requirement = result["body"]["accepts"][0]
    assert requirement["amount"] == "1000"
    assert requirement["asset"] == ARC_TESTNET["usdc"]
    assert requirement["payTo"] == SELLER
    assert requirement["extra"]["verifyingContract"] == ARC_TESTNET["gateway_wallet"]


@pytest.mark.asyncio
async def test_success_uses_server_owned_requirements() -> None:
    seen: dict = {}

    async def gateway(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "success": True,
                "transaction": "gateway-transfer-id",
                "network": ARC_TESTNET["network"],
                "payer": PAYER,
            },
        )

    http = httpx.AsyncClient(transport=httpx.MockTransport(gateway))
    facilitator = BatchFacilitatorClient(
        "https://gateway-api-testnet.circle.com/v1",
        http_client=http,
    )
    seller = SellerAgent(
        SellerConfig(seller_address=SELLER),
        facilitator=facilitator,
    )

    challenge = (await seller.process_request(None, RESOURCE, "$0.001"))["body"]
    header = encode_payload(challenge)
    result = await seller.process_request(header, RESOURCE, "$0.001")

    assert isinstance(result, PaymentInfo)
    assert result.verified is True
    assert result.amount == "0.001"
    assert result.amount_atomic == "1000"
    assert seen["url"] == (
        "https://gateway-api-testnet.circle.com/gateway/v1/x402/settle"
    )

    requirements = seen["body"]["paymentRequirements"]
    assert requirements["asset"] == ARC_TESTNET["usdc"]
    assert requirements["amount"] == "1000"
    assert requirements["payTo"] == SELLER

    await http.aclose()


@pytest.mark.asyncio
async def test_buyer_cannot_replace_seller_address() -> None:
    called = False

    async def gateway(_request: httpx.Request) -> httpx.Response:
        nonlocal called
        called = True
        return httpx.Response(500)

    http = httpx.AsyncClient(transport=httpx.MockTransport(gateway))
    seller = SellerAgent(
        SellerConfig(seller_address=SELLER),
        facilitator=BatchFacilitatorClient(
            "https://gateway-api-testnet.circle.com",
            http_client=http,
        ),
    )

    challenge = (await seller.process_request(None, RESOURCE, "$0.001"))["body"]
    attacker = "0x3333333333333333333333333333333333333333"
    header = encode_payload(challenge, accepted_override={"payTo": attacker})
    result = await seller.process_request(header, RESOURCE, "$0.001")

    assert isinstance(result, dict)
    assert result["status"] == 402
    assert called is False

    await http.aclose()


@pytest.mark.asyncio
async def test_http_200_success_false_never_unlocks_resource() -> None:
    async def gateway(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "success": False,
                "transaction": "",
                "network": ARC_TESTNET["network"],
                "errorReason": "amount_mismatch",
                "payer": PAYER,
            },
        )

    http = httpx.AsyncClient(transport=httpx.MockTransport(gateway))
    seller = SellerAgent(
        SellerConfig(seller_address=SELLER),
        facilitator=BatchFacilitatorClient(
            "https://gateway-api-testnet.circle.com",
            http_client=http,
        ),
    )

    challenge = (await seller.process_request(None, RESOURCE, "$0.001"))["body"]
    result = await seller.process_request(
        encode_payload(challenge),
        RESOURCE,
        "$0.001",
    )

    assert isinstance(result, dict)
    assert result["status"] == 402
    assert "amount_mismatch" in result["body"]["error"]
    assert result["body"]["retrySafe"] is False

    await http.aclose()


@pytest.mark.asyncio
async def test_same_signature_is_not_settled_twice() -> None:
    calls = 0

    async def gateway(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(
            200,
            json={
                "success": True,
                "transaction": "gateway-transfer-id",
                "network": ARC_TESTNET["network"],
                "payer": PAYER,
            },
        )

    http = httpx.AsyncClient(transport=httpx.MockTransport(gateway))
    seller = SellerAgent(
        SellerConfig(seller_address=SELLER),
        facilitator=BatchFacilitatorClient(
            "https://gateway-api-testnet.circle.com",
            http_client=http,
        ),
    )

    challenge = (await seller.process_request(None, RESOURCE, "$0.001"))["body"]
    header = encode_payload(challenge)

    first = await seller.process_request(header, RESOURCE, "$0.001")
    second = await seller.process_request(header, RESOURCE, "$0.001")

    assert isinstance(first, PaymentInfo)
    assert isinstance(second, PaymentInfo)
    assert first.replayed is False
    assert second.replayed is True
    assert calls == 1

    await http.aclose()
