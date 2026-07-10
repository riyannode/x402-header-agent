"""Dual-role agent: receive x402 payment, then spend to downstream.

Composes SellerAgent (receive payment) + X402ArcClient (pay downstream) into
a single agent that can receive payment for a route and spend from a separate
buyer wallet to downstream paid services.

The seller wallet receives payment for the route.
The buyer wallet pays downstream resources from inside the verified handler.
These wallets must be different.

Usage:
    agent = DualRoleAgent.from_env()

    # Framework-agnostic:
    result = await agent.process_request_with_spend(
        payment_header=request.headers.get("Payment-Signature"),
        path="/api/analyze",
        price="$0.01",
        handler=my_handler,
    )

    # handler signature:
    async def my_handler(spend, payment_info):
        downstream = await spend("https://backend.example.com/data")
        return {"paid_by": payment_info.payer, "data": downstream.get("data")}
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Dict, Optional

from .client import (
    X402ArcClient,
    X402ConfigError,
    CircleDcwNative,
    X402Policy,
    JsonFileLedger,
)
from .server import PaymentInfo, SellerAgent, SellerConfig


@dataclass
class DualRoleConfig:
    """Configuration for a dual-role agent.

    Seller receives payment. Buyer pays downstream. Must be different wallets.
    """

    # Seller
    seller_address: str
    seller_chain: str = "arcTestnet"
    seller_facilitator_url: str = ""
    seller_description: str = "Paid resource"
    seller_networks: list[str] | None = None

    # Buyer (DCW — no raw private key)
    buyer_api_key: str = ""
    buyer_wallet_id: str = ""
    buyer_wallet_address: str = ""
    buyer_entity_secret: str = ""
    buyer_blockchain: str = "ARC-TESTNET"
    buyer_chain: str = "arcTestnet"
    buyer_api_base: str = "https://api.circle.com"
    buyer_daily_budget_usdc: str = "10"
    buyer_max_single_payment_usdc: str = "1"
    buyer_host_allowlist: list[str] | None = None
    buyer_allow_localhost: bool = False


# Type for the spend function passed to the handler
SpendFunc = Callable[[str], Awaitable[Dict[str, Any]]]

# Type for the handler function
HandlerFunc = Callable[[SpendFunc, PaymentInfo], Awaitable[Any]]


class DualRoleAgent:
    """Receive x402 payment (seller role), then spend to downstream (buyer role).

    The seller wallet receives payment for the route.
    The buyer wallet pays downstream resources from inside the verified handler.
    These wallets must be different addresses.

    Buyer signing uses Circle DCW only. No raw private key.
    """

    def __init__(self, config: DualRoleConfig) -> None:
        # Validate seller ≠ buyer
        if config.seller_address.lower() == config.buyer_wallet_address.lower():
            raise X402ConfigError(
                "Seller wallet and buyer wallet must differ for dual-role agents"
            )

        self.config = config

        # Create seller
        self._seller = SellerAgent(SellerConfig(
            seller_address=config.seller_address,
            chain=config.seller_chain,
            facilitator_url=config.seller_facilitator_url,
            description=config.seller_description,
            networks=config.seller_networks or [],
        ))

        # Create buyer (DCW only — no raw private key)
        dcw = CircleDcwNative(
            api_key=config.buyer_api_key,
            wallet_id=config.buyer_wallet_id,
            wallet_address=config.buyer_wallet_address,
            entity_secret=config.buyer_entity_secret,
            blockchain=config.buyer_blockchain,
            api_base=config.buyer_api_base,
        )
        allowlist = config.buyer_host_allowlist or ["*"]
        policy = X402Policy(
            daily_budget_usdc=config.buyer_daily_budget_usdc,
            max_single_payment_usdc=config.buyer_max_single_payment_usdc,
            host_allowlist=allowlist,
            allow_localhost=config.buyer_allow_localhost,
        )
        self._buyer = X402ArcClient(dcw, policy=policy)

    @classmethod
    def from_env(cls) -> DualRoleAgent:
        """Create a DualRoleAgent from environment variables."""
        return cls(DualRoleConfig(
            # Seller
            seller_address=os.environ.get("SELLER_ADDRESS", ""),
            seller_chain=os.environ.get("X402_CHAIN", "arcTestnet"),
            seller_facilitator_url=os.environ.get("X402_FACILITATOR_URL", ""),
            seller_description=os.environ.get("X402_SELLER_DESCRIPTION", "Paid resource"),
            seller_networks=[n.strip() for n in os.environ.get("X402_SELLER_NETWORKS", "").split(",") if n.strip()],
            # Buyer (DCW)
            buyer_api_key=os.environ.get("CIRCLE_API_KEY", ""),
            buyer_wallet_id=os.environ.get("CIRCLE_DCW_WALLET_ID", ""),
            buyer_wallet_address=os.environ.get("CIRCLE_DCW_WALLET_ADDRESS", ""),
            buyer_entity_secret=os.environ.get("CIRCLE_ENTITY_SECRET", ""),
            buyer_blockchain=os.environ.get("CIRCLE_DCW_BLOCKCHAIN", "ARC-TESTNET"),
            buyer_chain=os.environ.get("X402_CHAIN", "arcTestnet"),
            buyer_api_base=os.environ.get("CIRCLE_API_BASE", "https://api.circle.com"),
            buyer_daily_budget_usdc=os.environ.get("X402_DAILY_BUDGET_USDC", "10"),
            buyer_max_single_payment_usdc=os.environ.get("X402_MAX_SINGLE_PAYMENT_USDC", "1"),
            buyer_host_allowlist=[x.strip() for x in os.environ.get("X402_HOST_ALLOWLIST", "").split(",") if x.strip()],
            buyer_allow_localhost=os.environ.get("X402_ALLOW_LOCALHOST", "false").lower() == "true",
        ))

    async def process_request_with_spend(
        self,
        payment_header: str | None,
        path: str,
        price: str,
        handler: HandlerFunc,
    ) -> dict[str, Any]:
        """Process a request: settle payment, call handler with spend(), return result.

        1. Seller: settle payment via Gateway (or return 402)
        2. Handler: receives spend() function and PaymentInfo
        3. Spend: handler calls spend(url) → buyer pays downstream

        Args:
            payment_header: Payment-Signature header value, or None
            path: Request path
            price: Price in USD (e.g., "$0.01")
            handler: async fn(spend, payment_info) -> response data

        Returns:
            dict with "status": 402 if payment needed/failed, or handler result.
        """
        # 1. Process payment (seller role)
        result = await self._seller.process_request(payment_header, path, price)

        if isinstance(result, dict):
            # 402 or error
            return result

        # 2. Payment verified — call handler with spend function
        payment_info: PaymentInfo = result

        async def spend(url: str, max_usdc: Optional[str] = None, **kwargs: Any) -> dict[str, Any]:
            """Pay for a downstream resource using the buyer wallet."""
            return self._buyer.pay_resource(url=url, max_usdc=max_usdc, **kwargs)

        try:
            data = await handler(spend, payment_info)
            return {"ok": True, "payment": {
                "payer": payment_info.payer,
                "amount": payment_info.amount,
                "network": payment_info.network,
                **({"transaction": payment_info.transaction} if payment_info.transaction else {}),
            }, "data": data}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    @property
    def seller(self) -> SellerAgent:
        """Access the seller agent."""
        return self._seller

    @property
    def buyer(self) -> X402ArcClient:
        """Access the buyer client."""
        return self._buyer

    async def close(self) -> None:
        """Close the buyer client."""
        pass  # httpx sync client doesn't need explicit close

    async def __aenter__(self) -> DualRoleAgent:
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self.close()
