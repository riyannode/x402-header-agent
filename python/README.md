# x402-header-agent Python

Native Python buyer for Circle Gateway x402 on Arc Testnet. Native only. No raw buyer private key. The SDK signs EIP-712 typed data by calling Circle Developer-Controlled Wallet `signTypedData` directly.

Install:

```bash
pip install -e .
# optional: pip install -e .[langchain]
# optional: pip install -e .[crewai]
```

Required env:

```bash
CIRCLE_API_KEY=...
CIRCLE_DCW_WALLET_ID=...
CIRCLE_DCW_WALLET_ADDRESS=0x...
CIRCLE_DCW_BLOCKCHAIN=ARC-TESTNET
CIRCLE_ENTITY_SECRET=...
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

Important: native Python uses `CIRCLE_ENTITY_SECRET` and encrypts it into a fresh `entitySecretCiphertext` per request, because Circle requires ciphertext uniqueness for replay protection. The TypeScript SDK handles this through Circle's official JS SDK.

> **Warning:** `CIRCLE_ENTITY_SECRET` is server-side only. Never ship it to browsers, mobile apps, frontend bundles, or untrusted agents.

## Package names

- Python package: `x402-header-agent`
- Python import: `from x402_arc_sdk import X402ArcClient`
