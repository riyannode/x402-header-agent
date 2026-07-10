"""Seller middleware for Circle Gateway x402 payments.

Framework-agnostic: exposes process_request() that takes generic inputs and
returns generic outputs. No framework imports.

Usage:
    seller = SellerAgent(seller_address="0x...", chain="arcTestnet")

    # In any async framework:
    result = await seller.process_request(
        payment_header=request.headers.get("PAYMENT-SIGNATURE"),
        path="/api/analyze",
        price="$0.01",
    )

    if isinstance(result, dict):
        # 402: return body + PAYMENT-REQUIRED header
        ...
    else:
        # PaymentInfo: return data + PAYMENT-RESPONSE header
        ...
"""
from __future__ import annotations

import base64
import json
import os
import secrets
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Optional

import httpx

from .client import (
    ARC_TESTNET,
    X402PaymentError,
    _b64_json,
    _decode_b64_json,
    _normalize_evm_signature,
    _normalize_usdc,
    _usdc_to_base_units,
)


PAYMENT_SIGNATURE_HEADER = "Payment-Signature"
PAYMENT_REQUIRED_HEADER = "Payment-Required"
PAYMENT_RESPONSE_HEADER = "Payment-Response"


@dataclass
class SellerConfig:
    """Configuration for x402 seller."""

    seller_address: str
    chain: str = "arcTestnet"
    facilitator_url: str = ""
    description: str = "Paid resource"
    networks: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        if not self.seller_address:
            raise ValueError("seller_address is required")
        if not self.facilitator_url:
            chain_config = _get_chain_config(self.chain)
            self.facilitator_url = _get_gateway_api_url(chain_config)


@dataclass
class PaymentInfo:
    """Payment information attached to request after verification."""

    verified: bool
    payer: str
    amount: str
    network: str
    transaction: str = ""

    @property
    def response_headers(self) -> dict[str, str]:
        """Headers to include in the response after successful payment."""
        return {PAYMENT_RESPONSE_HEADER: _b64_json({
            "payer": self.payer,
            "amount": self.amount,
            "network": self.network,
            **({"transaction": self.transaction} if self.transaction else {}),
        })}


class SellerAgent:
    """Framework-agnostic seller for x402 payments.

    Handles 402 responses, payment verification, and settlement via Circle Gateway.
    """

    def __init__(self, config: SellerConfig) -> None:
        self.config = config
        self._chain_config = _get_chain_config(config.chain)

    @classmethod
    def from_env(cls) -> SellerAgent:
        return cls(SellerConfig(
            seller_address=os.environ.get("SELLER_ADDRESS", ""),
            chain=os.environ.get("X402_CHAIN", "arcTestnet"),
            facilitator_url=os.environ.get("X402_FACILITATOR_URL", ""),
            description=os.environ.get("X402_SELLER_DESCRIPTION", "Paid resource"),
            networks=[n.strip() for n in os.environ.get("X402_SELLER_NETWORKS", "").split(",") if n.strip()],
        ))

    def _build_402_response(self, amount: str, path: str) -> dict[str, Any]:
        """Build a 402 Payment Required response body."""
        accepted = self._build_acceptance(amount)
        return {
            "x402Version": 2,
            "accepts": [accepted],
            "resource": path,
        }

    def _build_acceptance(self, amount: str) -> dict[str, Any]:
        """Build a single acceptance entry for the 402 response."""
        networks = self.config.networks or [self._chain_config["network"]]
        chain_config = _resolve_chain_config(networks[0])
        return {
            "scheme": "exact",
            "network": networks[0],
            "maxAmountRequired": str(_usdc_to_base_units(amount)),
            "resource": "",
            "description": self.config.description,
            "mimeType": "",
            "payTo": self.config.seller_address,
            "extra": {
                "name": "GatewayWalletBatched",
                "version": "1",
                "verifyingContract": chain_config["gateway_wallet"],
            },
        }

    async def settle(self, payment_header: str, price: str) -> PaymentInfo:
        """Settle a payment via Gateway API.

        Uses settle() directly — no separate verify() step needed.
        Gateway's settle() endpoint is optimized for low latency and
        guarantees settlement. (See Circle docs: "Use settle() directly
        rather than calling verify() followed by settle()")

        Returns PaymentInfo on success.
        """
        payload = _decode_b64_json(payment_header)

        x402_version = payload.get("x402Version", 2)
        inner_payload = payload.get("payload", {})
        resource = payload.get("resource")
        accepted = payload.get("accepted", {})

        settle_body = {
            "x402Version": x402_version,
            "payload": inner_payload,
            "resource": resource,
            "accepted": accepted,
        }

        facilitator_url = self.config.facilitator_url.rstrip("/")
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                f"{facilitator_url}/settle",
                json=settle_body,
                headers={"content-type": "application/json"},
            )

        if response.status_code >= 400:
            data = response.json() if "application/json" in response.headers.get("content-type", "") else {}
            raise X402PaymentError(
                f"Gateway settle failed: {response.status_code} "
                f"{data.get('message') or data.get('error') or response.text[:160]}"
            )

        settle_data = response.json() if "application/json" in response.headers.get("content-type", "") else {}

        # Extract payment info from settle response
        payer = inner_payload.get("authorization", {}).get("from", "")
        network = accepted.get("network", self._chain_config["network"])
        transaction = settle_data.get("transaction", "") or settle_data.get("txHash", "")

        return PaymentInfo(
            verified=True,
            payer=payer,
            amount=price.lstrip("$"),
            network=network,
            transaction=transaction,
        )

    async def process_request(
        self,
        payment_header: str | None,
        path: str,
        price: str,
    ) -> dict[str, Any] | PaymentInfo:
        """Process a request that may require payment.

        Convenience method that combines 402 and settle.
        No separate verify step — settle() directly handles both.

        Returns either:
          - A dict {"status": 402, "body": {...}} if payment needed/failed
          - A PaymentInfo on success

        Args:
            payment_header: Value of Payment-Signature header, or None
            path: Request path (e.g., "/api/analyze")
            price: Price in USD (e.g., "$0.01")
        """
        if not payment_header:
            return {"status": 402, "body": self._build_402_response(
                _normalize_usdc(price.lstrip("$")), path
            )}

        try:
            # Settle directly — no separate verify
            payment_info = await self.settle(payment_header, price)
            return payment_info
        except Exception as e:
            # Return 402 on settlement failure
            return {"status": 402, "body": {"error": str(e)}}


def create_seller_agent(config: SellerConfig) -> SellerAgent:
    """Create a SellerAgent from config."""
    return SellerAgent(config)


# --- Chain config helpers (mirrors client.py but for seller) ---

_GATEWAY_WALLETS = {
    "arcTestnet": "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
    "baseSepolia": "0x...",
}

_NETWORK_CHAIN_MAP = {
    "eip155:5042002": ARC_TESTNET,
}


def _get_chain_config(chain: str) -> dict[str, Any]:
    if chain == "arcTestnet":
        return ARC_TESTNET
    raise ValueError(f"Unsupported chain: {chain}")


def _resolve_chain_config(network: str) -> dict[str, Any]:
    if network in _NETWORK_CHAIN_MAP:
        return _NETWORK_CHAIN_MAP[network]
    # Fallback: parse chainId from CAIP-2
    if network.startswith("eip155:"):
        chain_id = int(network.split(":")[1])
        return {
            "chain": network,
            "network": network,
            "chain_id": chain_id,
            "gateway_wallet": _GATEWAY_WALLETS.get("arcTestnet", ""),
        }
    raise ValueError(f"Cannot resolve chain config for network: {network}")


def _get_gateway_api_url(chain_config: dict[str, Any]) -> str:
    if chain_config.get("chain") == "arcTestnet":
        return "https://gateway-api-testnet.circle.com/v1"
    return "https://gateway-api.circle.com/v1"
