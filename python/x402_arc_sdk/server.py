"""Native Python seller middleware for Circle Gateway x402 v2 nanopayments.

The public API remains intentionally small:

    seller = SellerAgent.from_env()
    result = await seller.process_request(payment_header, resource_url, "$0.001")

The seller, not the buyer, owns the payment requirements passed to Circle Gateway.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import re
from dataclasses import dataclass, field, replace
from typing import Any

import httpx

from .client import (
    ARC_TESTNET,
    MAX_PAYMENT_HEADER_BYTES,
    X402PaymentError,
    _b64_json,
    _normalize_usdc,
    _usdc_to_base_units,
)

PAYMENT_SIGNATURE_HEADER = "Payment-Signature"
PAYMENT_REQUIRED_HEADER = "Payment-Required"
PAYMENT_RESPONSE_HEADER = "Payment-Response"

X402_VERSION = 2
CIRCLE_BATCHING_SCHEME = "exact"
CIRCLE_BATCHING_NAME = "GatewayWalletBatched"
CIRCLE_BATCHING_VERSION = "1"
SERVER_MIN_TIMEOUT_SECONDS = 7 * 24 * 60 * 60 + 100
BUYER_MAX_TIMEOUT_SECONDS = 30 * 24 * 60 * 60

_ADDRESS_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")


def _validate_address(value: Any, field_name: str) -> str:
    if not isinstance(value, str) or not _ADDRESS_RE.fullmatch(value):
        raise ValueError(f"{field_name} must be a 0x-prefixed 20-byte EVM address")
    return value


def _decode_payment_signature(value: str) -> dict[str, Any]:
    if not isinstance(value, str) or not value.strip():
        raise X402PaymentError("Payment-Signature header is required")
    encoded = value.strip()
    if len(encoded.encode("utf-8")) > MAX_PAYMENT_HEADER_BYTES:
        raise X402PaymentError(
            f"Payment-Signature exceeds {MAX_PAYMENT_HEADER_BYTES} bytes"
        )
    padded = encoded + ("=" * (-len(encoded) % 4))
    try:
        raw = base64.b64decode(padded, altchars=b"-_", validate=True)
        decoded = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise X402PaymentError("Invalid Payment-Signature header") from exc
    if not isinstance(decoded, dict):
        raise X402PaymentError("Payment-Signature payload must be a JSON object")
    return decoded


def _canonical_json(value: Any) -> bytes:
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")


def _payment_fingerprint(decoded: dict[str, Any]) -> str:
    payload = decoded.get("payload")
    authorization = payload.get("authorization") if isinstance(payload, dict) else None
    signature = payload.get("signature") if isinstance(payload, dict) else None
    return hashlib.sha256(
        _canonical_json(
            {
                "authorization": authorization,
                "signature": signature,
                "accepted": decoded.get("accepted"),
            }
        )
    ).hexdigest()


def _normalize_settle_url(value: str) -> str:
    """Normalize Circle Gateway base URLs to the current x402 settle endpoint."""
    raw = value.strip().rstrip("/")
    if not raw:
        raw = "https://gateway-api-testnet.circle.com"

    if raw.endswith("/gateway/v1/x402/settle"):
        return raw
    if raw.endswith("/gateway/v1"):
        return f"{raw}/x402/settle"

    # Backward-compatible handling for the repository's former `.../v1` default.
    if raw.endswith("/v1/x402/settle"):
        raw = raw[: -len("/v1/x402/settle")]
    elif raw.endswith("/v1"):
        raw = raw[: -len("/v1")]
    elif raw.endswith("/x402/settle"):
        raw = raw[: -len("/x402/settle")]

    return f"{raw}/gateway/v1/x402/settle"


def _resolve_chain_config(network_or_chain: str) -> dict[str, Any]:
    if network_or_chain in {"arcTestnet", ARC_TESTNET["network"]}:
        return ARC_TESTNET
    raise ValueError(f"Unsupported seller network: {network_or_chain}")


@dataclass(frozen=True)
class SettleResult:
    success: bool
    transaction: str = ""
    payer: str = ""
    network: str = ""
    error_reason: str = ""


class BatchFacilitatorClient:
    """Typed HTTP client for Circle Gateway x402 settlement."""

    def __init__(
        self,
        url: str,
        *,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self.settle_url = _normalize_settle_url(url)
        self._http = http_client
        self._owned_http: httpx.AsyncClient | None = None

    def _client(self) -> httpx.AsyncClient:
        if self._http is not None:
            return self._http
        if self._owned_http is None:
            self._owned_http = httpx.AsyncClient(
                timeout=httpx.Timeout(connect=5.0, read=30.0, write=10.0, pool=5.0),
                follow_redirects=False,
                limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
            )
        return self._owned_http

    async def settle(
        self,
        payment_payload: dict[str, Any],
        payment_requirements: dict[str, Any],
    ) -> SettleResult:
        try:
            response = await self._client().post(
                self.settle_url,
                json={
                    "paymentPayload": payment_payload,
                    "paymentRequirements": payment_requirements,
                },
                headers={"content-type": "application/json"},
            )
        except (httpx.TimeoutException, httpx.TransportError) as exc:
            # The request may have reached Gateway. Do not claim it is safe to repay.
            raise X402PaymentError(
                f"Gateway settlement outcome is ambiguous: {type(exc).__name__}; "
                "do not automatically create another payment"
            ) from exc

        try:
            data = response.json()
        except (ValueError, json.JSONDecodeError) as exc:
            raise X402PaymentError(
                f"Gateway settle returned non-JSON response ({response.status_code})"
            ) from exc

        if response.status_code < 200 or response.status_code >= 300:
            reason = (
                data.get("errorReason")
                or data.get("message")
                or data.get("error")
                or "gateway request failed"
            )
            raise X402PaymentError(
                f"Gateway settle failed ({response.status_code}): {str(reason)[:200]}"
            )

        if not isinstance(data, dict) or not isinstance(data.get("success"), bool):
            raise X402PaymentError("Gateway settle returned an invalid response")

        if data["success"] is not True:
            return SettleResult(
                success=False,
                payer=str(data.get("payer") or ""),
                network=str(data.get("network") or ""),
                error_reason=str(data.get("errorReason") or "settlement rejected"),
            )

        transaction = data.get("transaction")
        if not isinstance(transaction, str) or not transaction:
            raise X402PaymentError("Gateway success response is missing transaction")

        return SettleResult(
            success=True,
            transaction=transaction,
            payer=str(data.get("payer") or ""),
            network=str(data.get("network") or payment_requirements["network"]),
        )

    async def aclose(self) -> None:
        if self._owned_http is not None:
            await self._owned_http.aclose()
            self._owned_http = None


@dataclass
class SellerConfig:
    seller_address: str
    chain: str = "arcTestnet"
    facilitator_url: str = "https://gateway-api-testnet.circle.com"
    description: str = "Paid resource"
    networks: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        _validate_address(self.seller_address, "seller_address")
        if not self.facilitator_url:
            self.facilitator_url = "https://gateway-api-testnet.circle.com"
        configured = self.networks or [self.chain]
        for network in configured:
            _resolve_chain_config(network)


@dataclass(frozen=True)
class PaymentInfo:
    verified: bool
    payer: str
    amount: str  # human USDC, retained for compatibility
    network: str
    transaction: str = ""
    amount_atomic: str = ""
    replayed: bool = False

    @property
    def response_headers(self) -> dict[str, str]:
        return {
            PAYMENT_RESPONSE_HEADER: _b64_json(
                {
                    "success": True,
                    "transaction": self.transaction,
                    "network": self.network,
                    "payer": self.payer,
                }
            )
        }


class SellerAgent:
    """Framework-agnostic native Python x402 seller."""

    def __init__(
        self,
        config: SellerConfig,
        *,
        facilitator: BatchFacilitatorClient | None = None,
    ) -> None:
        self.config = config
        self._network_configs = [
            _resolve_chain_config(value)
            for value in (config.networks or [config.chain])
        ]
        self._facilitator = facilitator or BatchFacilitatorClient(
            config.facilitator_url
        )
        self._receipt_guard = asyncio.Lock()
        self._payment_locks: dict[str, asyncio.Lock] = {}
        self._successful_receipts: dict[str, PaymentInfo] = {}

    @classmethod
    def from_env(cls) -> "SellerAgent":
        return cls(
            SellerConfig(
                seller_address=os.environ.get("SELLER_ADDRESS", ""),
                chain=os.environ.get("X402_CHAIN", "arcTestnet"),
                facilitator_url=os.environ.get(
                    "X402_FACILITATOR_URL",
                    "https://gateway-api-testnet.circle.com",
                ),
                description=os.environ.get(
                    "X402_SELLER_DESCRIPTION", "Paid resource"
                ),
                networks=[
                    value.strip()
                    for value in os.environ.get(
                        "X402_SELLER_NETWORKS", ""
                    ).split(",")
                    if value.strip()
                ],
            )
        )

    def _build_requirements(
        self,
        *,
        amount_atomic: str,
        chain_config: dict[str, Any],
    ) -> dict[str, Any]:
        return {
            "scheme": CIRCLE_BATCHING_SCHEME,
            "network": chain_config["network"],
            "asset": chain_config["usdc"],
            "amount": amount_atomic,
            "payTo": self.config.seller_address,
            "maxTimeoutSeconds": SERVER_MIN_TIMEOUT_SECONDS,
            "extra": {
                "name": CIRCLE_BATCHING_NAME,
                "version": CIRCLE_BATCHING_VERSION,
                "verifyingContract": chain_config["gateway_wallet"],
            },
        }

    def _build_402_response(
        self,
        amount_atomic: str,
        resource_url: str,
    ) -> dict[str, Any]:
        return {
            "x402Version": X402_VERSION,
            "resource": {
                "url": resource_url,
                "description": self.config.description,
                "mimeType": "application/json",
            },
            "accepts": [
                self._build_requirements(
                    amount_atomic=amount_atomic,
                    chain_config=chain_config,
                )
                for chain_config in self._network_configs
            ],
        }

    def require(self, price: str, resource_url: str) -> dict[str, Any]:
        amount_human = _normalize_usdc(price.lstrip("$"))
        if amount_human == "0":
            raise ValueError("seller price must be greater than zero")
        amount_atomic = str(_usdc_to_base_units(amount_human))
        body = self._build_402_response(amount_atomic, resource_url)
        return {
            "status": 402,
            "headers": {PAYMENT_REQUIRED_HEADER: _b64_json(body)},
            "body": body,
        }

    def _expected_for_selected_network(
        self,
        accepted: dict[str, Any],
        amount_atomic: str,
    ) -> dict[str, Any]:
        network = accepted.get("network")
        for chain_config in self._network_configs:
            if chain_config["network"] == network:
                return self._build_requirements(
                    amount_atomic=amount_atomic,
                    chain_config=chain_config,
                )
        raise X402PaymentError(f"Selected network is not accepted: {network!r}")

    def _validate_selected_requirement(
        self,
        accepted: dict[str, Any],
        expected: dict[str, Any],
    ) -> None:
        for field_name in ("scheme", "network", "asset", "amount", "payTo"):
            actual = accepted.get(field_name)
            target = expected[field_name]
            if (
                field_name in {"asset", "payTo"}
                and isinstance(actual, str)
                and isinstance(target, str)
            ):
                matches = actual.lower() == target.lower()
            else:
                matches = actual == target
            if not matches:
                raise X402PaymentError(
                    f"Selected payment requirement mismatch: {field_name}"
                )

        timeout = accepted.get("maxTimeoutSeconds")
        if isinstance(timeout, bool) or not isinstance(timeout, int):
            raise X402PaymentError("Invalid maxTimeoutSeconds")
        if timeout < expected["maxTimeoutSeconds"]:
            raise X402PaymentError("maxTimeoutSeconds is below the server minimum")
        if timeout > BUYER_MAX_TIMEOUT_SECONDS:
            raise X402PaymentError("maxTimeoutSeconds exceeds the defensive maximum")

        extra = accepted.get("extra")
        if not isinstance(extra, dict):
            raise X402PaymentError("Selected payment requirement is missing extra")
        for field_name in ("name", "version", "verifyingContract"):
            actual = extra.get(field_name)
            target = expected["extra"][field_name]
            if (
                field_name == "verifyingContract"
                and isinstance(actual, str)
                and isinstance(target, str)
            ):
                matches = actual.lower() == target.lower()
            else:
                matches = actual == target
            if not matches:
                raise X402PaymentError(
                    f"Selected payment requirement mismatch: extra.{field_name}"
                )

    def _validate_payment_payload(
        self,
        decoded: dict[str, Any],
        expected: dict[str, Any],
    ) -> tuple[str, dict[str, Any]]:
        if decoded.get("x402Version") != X402_VERSION:
            raise X402PaymentError("Unsupported x402Version")

        payload = decoded.get("payload")
        if not isinstance(payload, dict):
            raise X402PaymentError("Payment payload is missing payload")

        authorization = payload.get("authorization")
        if not isinstance(authorization, dict):
            raise X402PaymentError("Payment payload is missing authorization")

        signature = payload.get("signature")
        if not isinstance(signature, str) or not signature:
            raise X402PaymentError("Payment payload is missing signature")

        payer = _validate_address(authorization.get("from"), "payer")
        destination = _validate_address(authorization.get("to"), "authorization.to")

        if destination.lower() != expected["payTo"].lower():
            raise X402PaymentError("Authorization destination does not match seller")
        if str(authorization.get("value")) != expected["amount"]:
            raise X402PaymentError("Authorization amount does not match route price")

        nonce = authorization.get("nonce")
        if (
            not isinstance(nonce, str)
            or not nonce.startswith("0x")
            or len(nonce) != 66
        ):
            raise X402PaymentError("Authorization nonce must be bytes32")

        for field_name in ("validAfter", "validBefore"):
            value = authorization.get(field_name)
            try:
                parsed = int(str(value))
            except (TypeError, ValueError) as exc:
                raise X402PaymentError(
                    f"Authorization {field_name} must be an integer"
                ) from exc
            if parsed < 0:
                raise X402PaymentError(
                    f"Authorization {field_name} must not be negative"
                )

        return payer, authorization

    async def _lock_for_payment(self, fingerprint: str) -> asyncio.Lock:
        async with self._receipt_guard:
            return self._payment_locks.setdefault(fingerprint, asyncio.Lock())

    async def settle(self, payment_header: str, price: str) -> PaymentInfo:
        amount_human = _normalize_usdc(price.lstrip("$"))
        if amount_human == "0":
            raise X402PaymentError("seller price must be greater than zero")
        amount_atomic = str(_usdc_to_base_units(amount_human))

        decoded = _decode_payment_signature(payment_header)
        accepted = decoded.get("accepted")
        if not isinstance(accepted, dict):
            raise X402PaymentError("Payment payload is missing accepted requirement")

        expected = self._expected_for_selected_network(accepted, amount_atomic)
        self._validate_selected_requirement(accepted, expected)
        payer, _authorization = self._validate_payment_payload(decoded, expected)

        fingerprint = _payment_fingerprint(decoded)
        payment_lock = await self._lock_for_payment(fingerprint)

        async with payment_lock:
            cached = self._successful_receipts.get(fingerprint)
            if cached is not None:
                return replace(cached, replayed=True)

            settlement = await self._facilitator.settle(decoded, expected)
            if settlement.success is not True:
                raise X402PaymentError(
                    f"Gateway rejected settlement: {settlement.error_reason}"
                )

            payment = PaymentInfo(
                verified=True,
                payer=settlement.payer or payer,
                amount=amount_human,
                amount_atomic=amount_atomic,
                network=settlement.network or expected["network"],
                transaction=settlement.transaction,
            )
            self._successful_receipts[fingerprint] = payment
            return payment

    async def process_request(
        self,
        payment_header: str | None,
        path: str,
        price: str,
    ) -> dict[str, Any] | PaymentInfo:
        challenge = self.require(price, path)
        if not payment_header:
            return challenge

        try:
            return await self.settle(payment_header, price)
        except Exception as exc:
            return {
                **challenge,
                "body": {
                    "error": str(exc),
                    "retrySafe": False,
                },
            }

    async def aclose(self) -> None:
        await self._facilitator.aclose()


def create_seller_agent(config: SellerConfig) -> SellerAgent:
    return SellerAgent(config)
