"""Tests for DualRoleAgent and SellerAgent."""
from __future__ import annotations

import json
import os
import base64
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from x402_arc_sdk.server import SellerAgent, SellerConfig, PaymentInfo
from x402_arc_sdk.dual_role import DualRoleAgent, DualRoleConfig
from x402_arc_sdk.client import X402ArcClient, X402ConfigError


# --- Fixtures ---

SELLER_ADDRESS = "0x1111111111111111111111111111111111111111"
BUYER_ADDRESS = "0x2222222222222222222222222222222222222222"
SAME_ADDRESS = "0x3333333333333333333333333333333333333333"


def _b64_json(data: dict) -> str:
    return base64.b64encode(json.dumps(data, separators=(",", ":")).encode()).decode()


def _fake_payment_header() -> str:
    """Create a fake payment header for testing."""
    return _b64_json({
        "x402Version": 2,
        "payload": {
            "authorization": {
                "from": BUYER_ADDRESS,
                "to": SELLER_ADDRESS,
                "value": "1000",
                "validAfter": "0",
                "validBefore": "9999999999",
                "nonce": "0x" + "00" * 32,
            },
            "signature": "0x" + "ab" * 65,
        },
        "resource": "/api/test",
        "accepted": {
            "scheme": "exact",
            "network": "eip155:5042002",
            "asset": "0x3600000000000000000000000000000000000000",
            "amount": "1000",
            "payTo": SELLER_ADDRESS,
            "maxTimeoutSeconds": 604900,
            "extra": {
                "name": "GatewayWalletBatched",
                "version": "1",
                "verifyingContract": "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
            },
        },
    })


# --- SellerAgent tests ---

class TestSellerAgent:
    def test_config_validation(self):
        with pytest.raises(ValueError, match="must be a 0x-prefixed 20-byte EVM address"):
            SellerConfig(seller_address="")

    def test_build_402_response(self):
        seller = SellerAgent(SellerConfig(seller_address=SELLER_ADDRESS))
        resp = seller._build_402_response("0.001", "/api/test")
        assert resp["x402Version"] == 2
        assert "accepts" in resp
        assert resp["resource"]["url"] == "/api/test"
        assert resp["accepts"][0]["payTo"] == SELLER_ADDRESS
        assert resp["accepts"][0]["scheme"] == "exact"

    def test_build_requirements(self):
        seller = SellerAgent(SellerConfig(seller_address=SELLER_ADDRESS))
        acc = seller._build_requirements(
            amount_atomic="10000",
            chain_config={"network": "eip155:5042002", "usdc": "0x3600000000000000000000000000000000000000", "gateway_wallet": "0x0077777d7EBA4688BDeF3E311b846F25870A19B9"},
        )
        assert acc["payTo"] == SELLER_ADDRESS
        assert acc["network"] == "eip155:5042002"
        assert acc["amount"] == "10000"

    def test_from_env(self):
        os.environ["SELLER_ADDRESS"] = SELLER_ADDRESS
        try:
            seller = SellerAgent.from_env()
            assert seller.config.seller_address == SELLER_ADDRESS
        finally:
            del os.environ["SELLER_ADDRESS"]


class TestPaymentInfo:
    def test_response_headers(self):
        info = PaymentInfo(
            verified=True,
            payer=BUYER_ADDRESS,
            amount="0.001",
            network="eip155:5042002",
            transaction="0xabc",
        )
        headers = info.response_headers
        assert "Payment-Response" in headers
        decoded = json.loads(base64.b64decode(headers["Payment-Response"]))
        assert decoded["payer"] == BUYER_ADDRESS
        assert decoded["transaction"] == "0xabc"


# --- DualRoleAgent tests ---

class TestDualRoleAgent:
    def test_same_wallet_rejected(self):
        with pytest.raises(X402ConfigError, match="must differ"):
            DualRoleAgent(DualRoleConfig(
                seller_address=SAME_ADDRESS,
                buyer_wallet_address=SAME_ADDRESS,
                buyer_wallet_id="test",
                buyer_api_key="test",
                buyer_entity_secret="0" * 64,
            ))

    def test_different_wallets_ok(self):
        agent = DualRoleAgent(DualRoleConfig(
            seller_address=SELLER_ADDRESS,
            buyer_wallet_address=BUYER_ADDRESS,
            buyer_wallet_id="test-wallet-id",
            buyer_api_key="test-api-key",
            buyer_entity_secret="0" * 64,
        ))
        assert agent.seller.config.seller_address == SELLER_ADDRESS
        assert agent.buyer.dcw.wallet_address == BUYER_ADDRESS

    def test_from_env(self):
        os.environ["SELLER_ADDRESS"] = SELLER_ADDRESS
        os.environ["CIRCLE_API_KEY"] = "test-key"
        os.environ["CIRCLE_DCW_WALLET_ID"] = "test-wallet"
        os.environ["CIRCLE_DCW_WALLET_ADDRESS"] = BUYER_ADDRESS
        os.environ["CIRCLE_ENTITY_SECRET"] = "0" * 64
        try:
            agent = DualRoleAgent.from_env()
            assert agent.seller.config.seller_address == SELLER_ADDRESS
            assert agent.buyer.dcw.wallet_address == BUYER_ADDRESS
        finally:
            for k in ["SELLER_ADDRESS", "CIRCLE_API_KEY", "CIRCLE_DCW_WALLET_ID",
                       "CIRCLE_DCW_WALLET_ADDRESS", "CIRCLE_ENTITY_SECRET"]:
                os.environ.pop(k, None)

    @pytest.mark.asyncio
    async def test_process_request_no_payment_returns_402(self):
        agent = DualRoleAgent(DualRoleConfig(
            seller_address=SELLER_ADDRESS,
            buyer_wallet_address=BUYER_ADDRESS,
            buyer_wallet_id="test-wallet-id",
            buyer_api_key="test-api-key",
            buyer_entity_secret="0" * 64,
        ))

        async def handler(spend, payment):
            return {"data": "should not reach here"}

        result = await agent.process_request_with_spend(
            payment_header=None,
            path="/api/test",
            price="$0.001",
            handler=handler,
        )
        assert result["status"] == 402
        assert "accepts" in result["body"]

    @pytest.mark.asyncio
    async def test_process_request_with_spend_calls_handler(self):
        agent = DualRoleAgent(DualRoleConfig(
            seller_address=SELLER_ADDRESS,
            buyer_wallet_address=BUYER_ADDRESS,
            buyer_wallet_id="test-wallet-id",
            buyer_api_key="test-api-key",
            buyer_entity_secret="0" * 64,
        ))

        # Mock the seller's settle to return PaymentInfo
        fake_payment = PaymentInfo(
            verified=True,
            payer=BUYER_ADDRESS,
            amount="0.001",
            network="eip155:5042002",
            transaction="0xtx",
        )
        agent._seller.settle = AsyncMock(return_value=fake_payment)

        # Mock the buyer's pay_resource
        agent._buyer.pay_resource = MagicMock(return_value={"status": "success", "data": "downstream result"})

        async def handler(spend, payment):
            assert payment.payer == BUYER_ADDRESS
            result = await spend("https://backend.example.com/data")
            return result

        result = await agent.process_request_with_spend(
            payment_header=_fake_payment_header(),
            path="/api/test",
            price="$0.001",
            handler=handler,
        )

        assert result["ok"] is True
        assert result["payment"]["payer"] == BUYER_ADDRESS
        assert result["data"]["status"] == "success"
        agent._buyer.pay_resource.assert_called_once_with(
            url="https://backend.example.com/data", max_usdc=None
        )

    @pytest.mark.asyncio
    async def test_process_request_handler_error(self):
        agent = DualRoleAgent(DualRoleConfig(
            seller_address=SELLER_ADDRESS,
            buyer_wallet_address=BUYER_ADDRESS,
            buyer_wallet_id="test-wallet-id",
            buyer_api_key="test-api-key",
            buyer_entity_secret="0" * 64,
        ))

        fake_payment = PaymentInfo(
            verified=True,
            payer=BUYER_ADDRESS,
            amount="0.001",
            network="eip155:5042002",
        )
        agent._seller.settle = AsyncMock(return_value=fake_payment)

        async def handler(spend, payment):
            raise RuntimeError("handler failed")

        result = await agent.process_request_with_spend(
            payment_header=_fake_payment_header(),
            path="/api/test",
            price="$0.001",
            handler=handler,
        )

        assert result["ok"] is False
        assert "handler failed" in result["error"]
