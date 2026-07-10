# x402-header-agent Python

Native Python buyer, seller, and dual-role agent for Circle Gateway x402 on Arc Testnet. No raw buyer private key — signing uses Circle Developer-Controlled Wallet `signTypedData` directly.

Install:

```bash
pip install -e .
# optional: pip install -e .[langchain]
# optional: pip install -e .[crewai]
```

## Buyer

Pay for x402-protected resources.

Required env:

```bash
CIRCLE_API_KEY=***
CIRCLE_DCW_WALLET_ID=...
CIRCLE_DCW_WALLET_ADDRESS=0x...
CIRCLE_DCW_BLOCKCHAIN=ARC-TESTNET
CIRCLE_ENTITY_SECRET=***
X402_ALLOW_LOCALHOST=false
X402_HOST_ALLOWLIST=seller.example.com
```

Three-line custom integration:

```python
from x402_arc_sdk import X402ArcClient
client = X402ArcClient.from_env()
tools = client.custom_tools()
```

Three-line LangChain integration:

```python
from x402_arc_sdk import X402ArcClient
client = X402ArcClient.from_env()
tools = client.langchain_tools()
```

Pay directly from Python:

```python
receipt = client.pay_resource("https://seller.example.com/premium", max_usdc="0.001")
```

## Seller

Protect endpoints with x402 payments. Framework-agnostic middleware.

Required env:

```bash
SELLER_ADDRESS=0x...
X402_CHAIN=arcTestnet
```

Framework-agnostic usage (FastAPI, aiohttp, Starlette, etc.):

```python
from x402_arc_sdk import SellerAgent

seller = SellerAgent.from_env()

async def handle_request(request):
    result = await seller.process_request(
        payment_header=request.headers.get("Payment-Signature"),
        path=request.url.path,
        price="$0.01",
    )

    if isinstance(result, dict):
        # 402: return body + PAYMENT-REQUIRED header
        return JSONResponse(result["body"], status_code=402,
                            headers={"Payment-Required": "..."})

    # PaymentInfo: return data + PAYMENT-RESPONSE header
    return JSONResponse({"data": "Premium content", "paid_by": result.payer},
                        headers=result.response_headers)
```

## Dual-Role Agent

Receive x402 payment (seller), then spend to downstream (buyer). One service receives payment for a route and pays downstream from a separate buyer wallet.

**Seller and buyer wallets must be different addresses.**

Required env:

```bash
# Seller
SELLER_ADDRESS=0x...
X402_CHAIN=arcTestnet

# Buyer (DCW — no raw private key)
CIRCLE_API_KEY=***
CIRCLE_DCW_WALLET_ID=...
CIRCLE_DCW_WALLET_ADDRESS=0x...
CIRCLE_ENTITY_SECRET=***
X402_HOST_ALLOWLIST=backend.example.com
```

Framework-agnostic usage:

```python
from x402_arc_sdk import DualRoleAgent

agent = DualRoleAgent.from_env()

async def handle_request(request):
    result = await agent.process_request_with_spend(
        payment_header=request.headers.get("Payment-Signature"),
        path=request.url.path,
        price="$0.01",
        handler=my_handler,
    )
    # result is either {"status": 402, ...} or {"ok": True, "payment": {...}, "data": ...}

async def my_handler(spend, payment_info):
    # payment_info.payer = who paid
    # spend(url) = pay downstream using buyer wallet
    downstream = await spend("https://backend.example.com/data")
    return {"paid_by": payment_info.payer, "data": downstream.get("data")}
```

With explicit config:

```python
from x402_arc_sdk import DualRoleAgent, DualRoleConfig

agent = DualRoleAgent(DualRoleConfig(
    seller_address="0x...",
    buyer_wallet_id="...",
    buyer_wallet_address="0x...",
    buyer_api_key="...",
    buyer_entity_secret="...",
))
```

## Security

- No buyer raw private key env or code path.
- Buyer signing encrypts `CIRCLE_ENTITY_SECRET` into a fresh `entitySecretCiphertext` per request.
- Seller uses Circle Gateway facilitator for verify/settle.
- Do not log `CIRCLE_ENTITY_SECRET`, raw signatures, full `Payment-Signature`, API keys, or wallet IDs.
- `CIRCLE_ENTITY_SECRET` is server-side only. Never ship to browsers, mobile apps, frontend bundles, or untrusted agents.

## Package names

- Python package: `x402-header-agent`
- Python import: `from x402_arc_sdk import X402ArcClient, SellerAgent, DualRoleAgent`
