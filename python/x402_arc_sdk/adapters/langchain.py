from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, Field

from ..client import X402ArcClient


class PayResourceArgs(BaseModel):
    url: str
    label: Optional[str] = None
    max_usdc: Optional[str] = Field(default=None, pattern=r"^\d+(\.\d{1,6})?$")


class PayBatchArgs(BaseModel):
    urls: list[str] = Field(min_length=1, max_length=50)
    max_usdc_per_resource: Optional[str] = Field(default=None, pattern=r"^\d+(\.\d{1,6})?$")
    concurrency: int = Field(default=4, ge=1, le=16)


class DepositArgs(BaseModel):
    amount_usdc: str = Field(pattern=r"^\d+(\.\d{1,6})?$")
    approve_amount_usdc: Optional[str] = Field(default=None, pattern=r"^\d+(\.\d{1,6})?$")
    skip_approval: bool = False
    assume_approval_confirmed: bool = False
    idempotency_prefix: Optional[str] = None


def get_langchain_tools(client: X402ArcClient) -> list[Any]:
    try:
        from langchain_core.tools import StructuredTool
    except ImportError as exc:
        raise ImportError("Install optional dependency: pip install 'x402-arc-sdk[langchain]'") from exc

    return [
        StructuredTool.from_function(lambda url, label=None, max_usdc=None: str(client.pay_resource(url=url, label=label, max_usdc=max_usdc)), name="x402_pay_resource", description="Pay one x402 Circle Gateway resource using native Python + Circle DCW signTypedData. No raw buyer private key.", args_schema=PayResourceArgs),
        StructuredTool.from_function(lambda urls, max_usdc_per_resource=None, concurrency=4: str(client.pay_batch(urls=urls, max_usdc_per_resource=max_usdc_per_resource, concurrency=concurrency)), name="x402_pay_batch", description="Pay multiple x402 resources after fail-closed preflight.", args_schema=PayBatchArgs),
        StructuredTool.from_function(lambda: str(client.gateway_balance()), name="x402_gateway_balance", description="Check Circle Gateway USDC balance."),
        StructuredTool.from_function(lambda amount_usdc, approve_amount_usdc=None, skip_approval=False, assume_approval_confirmed=False, idempotency_prefix=None: str(client.gateway_deposit(amount_usdc=amount_usdc, approve_amount_usdc=approve_amount_usdc, skip_approval=skip_approval, assume_approval_confirmed=assume_approval_confirmed, idempotency_prefix=idempotency_prefix)), name="x402_gateway_deposit", description="Create Circle DCW approval/deposit contract execution transactions.", args_schema=DepositArgs),
        StructuredTool.from_function(lambda url: str(client.supports(url=url)), name="x402_supports", description="Probe whether a URL supports Circle Gateway x402 batching."),
    ]
