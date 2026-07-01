from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, Field, PrivateAttr

from ..client import X402ArcClient


class PayResourceInput(BaseModel):
    url: str = Field(description="HTTPS x402-protected resource URL")
    label: Optional[str] = None
    max_usdc: Optional[str] = Field(default=None, pattern=r"^\d+(\.\d{1,6})?$")


class PayBatchInput(BaseModel):
    urls: list[str] = Field(min_length=1, max_length=50)
    max_usdc_per_resource: Optional[str] = Field(default=None, pattern=r"^\d+(\.\d{1,6})?$")
    concurrency: int = Field(default=4, ge=1, le=16)


class EmptyInput(BaseModel):
    pass


class SupportsInput(BaseModel):
    url: str


def get_crewai_tools(client: X402ArcClient) -> list[Any]:
    try:
        from crewai.tools import BaseTool
    except ImportError as exc:
        raise ImportError("Install optional dependency: pip install 'x402-arc-sdk[crewai]'") from exc

    class X402PayResourceTool(BaseTool):
        name: str = "x402_pay_resource"
        description: str = "Pay one x402 resource using native Python + Circle DCW signTypedData. No raw buyer private key."
        args_schema: type[BaseModel] = PayResourceInput
        _client: X402ArcClient = PrivateAttr()
        def __init__(self, client: X402ArcClient):
            super().__init__(); self._client = client
        def _run(self, url: str, label: Optional[str] = None, max_usdc: Optional[str] = None) -> str:
            return str(self._client.pay_resource(url=url, label=label, max_usdc=max_usdc))

    class X402PayBatchTool(BaseTool):
        name: str = "x402_pay_batch"
        description: str = "Pay multiple x402 resources after fail-closed preflight."
        args_schema: type[BaseModel] = PayBatchInput
        _client: X402ArcClient = PrivateAttr()
        def __init__(self, client: X402ArcClient):
            super().__init__(); self._client = client
        def _run(self, urls: list[str], max_usdc_per_resource: Optional[str] = None, concurrency: int = 4) -> str:
            return str(self._client.pay_batch(urls=urls, max_usdc_per_resource=max_usdc_per_resource, concurrency=concurrency))

    class X402GatewayBalanceTool(BaseTool):
        name: str = "x402_gateway_balance"
        description: str = "Check Circle Gateway USDC balance."
        args_schema: type[BaseModel] = EmptyInput
        _client: X402ArcClient = PrivateAttr()
        def __init__(self, client: X402ArcClient):
            super().__init__(); self._client = client
        def _run(self) -> str:
            return str(self._client.gateway_balance())

    class X402SupportsTool(BaseTool):
        name: str = "x402_supports"
        description: str = "Probe whether a URL supports Circle Gateway x402 batching."
        args_schema: type[BaseModel] = SupportsInput
        _client: X402ArcClient = PrivateAttr()
        def __init__(self, client: X402ArcClient):
            super().__init__(); self._client = client
        def _run(self, url: str) -> str:
            return str(self._client.supports(url))

    return [X402PayResourceTool(client), X402PayBatchTool(client), X402GatewayBalanceTool(client), X402SupportsTool(client)]
