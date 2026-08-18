# x402-header-agent

x402 buyer / seller / dual-role agent SDK for Circle Gateway nanopayments on Arc. Buyer signing uses Circle Developer-Controlled Wallets (DCW), not raw private keys.

This package uses the Circle Gateway batched x402 flow: seller returns HTTP `402` with `PAYMENT-REQUIRED`; buyer signs an EIP-3009/EIP-712 `TransferWithAuthorization` against the `GatewayWalletBatched` domain through Circle DCW; buyer retries with `Payment-Signature`; seller settles through Circle Gateway and returns `PAYMENT-RESPONSE`.

## Scope

This repo is the **x402 payment SDK**: buyer, seller, dual-role agent, Circle DCW signing, framework adapters (LangChain / CrewAI / OpenAI tools / plain functions), and payment policy enforcement.

**Out of scope:** durable per-user DCW provisioning and Gateway wallet lifecycle/recovery (wallet creation per end user, deposit reconciliation, withdrawal orchestration, balance recovery flows). That belongs to [`arc-dcw-gateway-kit`](https://github.com/riyannode/arc-dcw-gateway-kit), which is a **separate, complementary** project.

`arc-dcw-gateway-kit` is **not** a dependency of this package and is not required to use it. This SDK takes an already-provisioned DCW wallet (id + address) plus a funded Gateway balance and handles the x402 payment protocol on top. The two compose at the config boundary: the kit supplies wallet/balance lifecycle, this SDK spends and settles.

## Includes

- TypeScript buyer: `BuyerBatchAgent` using Circle official `@circle-fin/x402-batching` + Circle DCW signer.
- TypeScript seller: `SellerBatchAgent` and Express middleware wrapper.
- TypeScript dual-role: `DualRoleAgent` (composition wrapper).
- Native Python buyer: `X402ArcClient`, native only, no raw buyer key.
- Native Python seller: `SellerAgent`, framework-agnostic middleware.
- Native Python dual-role: `DualRoleAgent` (receive payment + spend to downstream, DCW only).
- LangChain, CrewAI-style, OpenAI/custom tool adapters.
- Single payment and batch payment.
- Policy caps: daily budget, max single payment, max batch payment, host allowlist, HTTPS requirement.

## Install

This package is not published to npm/PyPI yet.

Install the TypeScript package directly from GitHub:

```bash
npm install github:riyannode/x402-header-agent
```

For reproducible installs, pin a commit:

```bash
npm install github:riyannode/x402-header-agent#<commit-sha>
```

Install the native Python package directly from the repo subdirectory:

```bash
pip install "git+https://github.com/riyannode/x402-header-agent.git#subdirectory=python"
```

Python import:

```python
from x402_arc_sdk import X402ArcClient, SellerAgent, DualRoleAgent
```

## Local verification

```bash
git clone https://github.com/riyannode/x402-header-agent.git
cd x402-header-agent
npm install
npm run typecheck
npm test
npm run build
npm audit --audit-level=moderate
```

Python local verification:

```bash
cd python
python3 -m venv .venv
. .venv/bin/activate
pip install -e ".[dev]"
PYTHONPATH=. python -m pytest -q
```

CI runs the same TypeScript and Python checks on every push and pull request; see `.github/workflows/ci.yml`.

## Env

TypeScript buyer uses Circle JS SDK:

```bash
CIRCLE_API_KEY=...
CIRCLE_ENTITY_SECRET=...
CIRCLE_DCW_WALLET_ID=...
CIRCLE_DCW_WALLET_ADDRESS=0x...
CIRCLE_DCW_BLOCKCHAIN=ARC-TESTNET
```

Native Python buyer calls Circle REST directly and encrypts CIRCLE_ENTITY_SECRET into a fresh entitySecretCiphertext per request:

```bash
CIRCLE_API_KEY=...
CIRCLE_ENTITY_SECRET=...
CIRCLE_DCW_WALLET_ID=...
CIRCLE_DCW_WALLET_ADDRESS=0x...
CIRCLE_DCW_BLOCKCHAIN=ARC-TESTNET
```

Shared policy:

```bash
X402_CHAIN=arcTestnet
X402_NETWORK=eip155:5042002
ARC_RPC_URL=https://rpc.testnet.arc.network
X402_DAILY_BUDGET_USDC=10
X402_MAX_SINGLE_PAYMENT_USDC=1
X402_MAX_BATCH_PAYMENT_USDC=5
X402_HOST_ALLOWLIST=seller.example.com
X402_ALLOW_LOCALHOST=false
```

Seller:

```bash
SELLER_ADDRESS=0x...
X402_FACILITATOR_URL=https://gateway-api-testnet.circle.com
X402_DEFAULT_PRICE_USDC=0.001
```

## Three-line integrations

TypeScript LangChain:

```ts
const buyer = new BuyerBatchAgent(buyerConfigFromEnv());
const tools = await getLangChainBuyerTools(buyer);
agent = createAgent({ tools });
```

TypeScript custom:

```ts
const buyer = new BuyerBatchAgent(buyerConfigFromEnv());
const tools = buyerPlainFunctions(buyer);
await tools.x402_pay_batch({ requests: [{ url: "https://seller.example.com/data" }] });
```

Native Python LangChain/CrewAI/custom:

```python
from x402_arc_sdk import X402ArcClient
client = X402ArcClient.from_env()
tools = client.langchain_tools()
```

Native Python direct payment:

```python
from x402_arc_sdk import X402ArcClient
client = X402ArcClient.from_env()
receipt = client.pay_resource("https://seller.example.com/premium", max_usdc="0.001")
```

## Seller

TypeScript:

```ts
import express from "express";
import { SellerBatchAgent, mountPaidJsonRoute, sellerConfigFromEnv } from "x402-header-agent";

const app = express();
const seller = new SellerBatchAgent(sellerConfigFromEnv());

mountPaidJsonRoute(app, "get", "/premium-data", seller, { priceUsdc: "0.001" }, async (payment) => ({
  paidBy: payment.payer,
  content: "paid payload",
}));

app.listen(3000);
```

Python (framework-agnostic):

```python
from x402_arc_sdk import PaymentInfo, SellerAgent

seller = SellerAgent.from_env()

result = await seller.process_request(
    payment_header=request.headers.get("Payment-Signature"),
    path=str(request.url),
    price="$0.001",
)

if isinstance(result, dict):
    return Response(
        status=result["status"],
        headers=result.get("headers", {}),
        body=result["body"],
    )

payment: PaymentInfo = result

return Response(
    status=200,
    headers=payment.response_headers,
    body={
        "paidBy": payment.payer,
        "transaction": payment.transaction,
        "content": "paid payload",
    },
)
```

FastAPI live seller:

```bash
cd python
pip install -e ".[all]"

export SELLER_ADDRESS="0x..."
export X402_CHAIN="arcTestnet"
export X402_FACILITATOR_URL="https://gateway-api-testnet.circle.com"

uvicorn examples.seller_fastapi:app \
  --host 127.0.0.1 \
  --port 3001
```

## Dual-role agent

Use `DualRoleAgent` when one service needs to receive an x402 payment first, then spend from a separate buyer wallet to downstream paid services. The seller wallet receives payment for the route. The buyer wallet pays downstream resources from inside the verified handler. These wallets must be different.

`DualRoleAgent` is only a composition wrapper over `SellerBatchAgent` and `BuyerBatchAgent`. It does not change Circle DCW signing, seller settlement, policy caps, or host allowlist behavior.

```ts
import {
  DualRoleAgent,
  buyerConfigFromEnv,
  sellerConfigFromEnv,
} from "x402-header-agent";

const agent = new DualRoleAgent({
  seller: sellerConfigFromEnv(),
  buyer: buyerConfigFromEnv(),
});

// Express route: receive x402 payment, then spend to a downstream resource
const [middleware, controller] = agent.paidJsonRouteWithSpend(
  { priceUsdc: "0.01" },
  async (spend, req, payment) => {
    // payment verified — seller received funds
    // spend() calls buyer.payResource() from the buyer wallet
    const downstream = await spend({ url: "https://backend.example.com/data" });
    return { paidBy: payment.payer, downstream: downstream.data };
  },
);
```

> **Note:** Seller and buyer wallets must be different addresses. The constructor throws `ConfigurationError` if they match.

## Live validation

```bash
X402_ALLOW_LOCALHOST=true npm run example:seller
curl -i http://localhost:3000/premium-data
X402_ALLOW_LOCALHOST=true npm run example:buyer -- http://localhost:3000/premium-data
X402_ALLOW_LOCALHOST=true npm run example:batch -- http://localhost:3000/premium-data http://localhost:3000/premium-data
```

Python live payment, after Gateway balance is funded:

```bash
cd python
. .venv/bin/activate
python - <<'PY'
from x402_arc_sdk import X402ArcClient
client = X402ArcClient.from_env()
print(client.pay_resource("http://localhost:3000/premium-data", max_usdc="0.001"))
PY
```

Use `X402_ALLOW_LOCALHOST=true` only for local validation. Public production endpoints should use HTTPS and a strict `X402_HOST_ALLOWLIST`.

> **Note:** Use `X402_HOST_ALLOWLIST=*` only for explicit local demo/testing, never production.

> **Note:** Buyer signing uses Circle DCW only. This SDK does not support raw private key buyer signing.

> **Note:** Native Python signing is server-side only. Never ship `CIRCLE_ENTITY_SECRET` to browsers, mobile apps, frontend bundles, or untrusted agents.

## Package names

- TypeScript package name: `x402-header-agent`
- Python package name: `x402-header-agent`
- Python import: `from x402_arc_sdk import X402ArcClient, SellerAgent, DualRoleAgent`
- Distribution status: not published to npm/PyPI yet; install from GitHub.

## Circle Gateway endpoints

The seller settles through Circle Gateway's x402 API. Canonical paths (Circle Gateway OpenAPI, `gateway-api-testnet.circle.com` / `gateway-api.circle.com`):

| Purpose | Endpoint |
| --- | --- |
| Settle an x402 payment | `POST {base}/v1/x402/settle` |
| Supported payment kinds | `GET {base}/v1/x402/supported` |
| Gateway balances | `POST {base}/v1/balances` |

Per Circle's guidance, sellers call `settle()` directly rather than `verify()` followed by `settle()`. Payment authorizations must carry at least 7 days of validity plus a buffer (`minValiditySeconds` is `604800`; this SDK signs `604900`).

Gateway deposits use `depositFor(address token, address depositor, uint256 value)` on the Gateway Wallet contract. This matches the current `GATEWAY_WALLET_ABI` in `@circle-fin/x402-batching` and is intentionally unchanged.

## Security

- No buyer raw private key env or code path.
- TypeScript signs through Circle DCW JS SDK.
- Python signs through Circle DCW REST `signTypedData` using `CIRCLE_ENTITY_SECRET`.
- Do not log `CIRCLE_ENTITY_SECRET`, raw signatures, full `Payment-Signature`, API keys, wallet IDs, or payment payloads.
- DCW buyer must be EOA-compatible for Gateway offchain signature verification.
