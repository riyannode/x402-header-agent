import type { BuyerAgentConfig, PaymentPolicyConfig, SellerAgentConfig } from "./types.js";
import { ConfigurationError } from "./errors.js";
import { FileSpendLedger } from "./ledger.js";

export const DEFAULT_POLICY: PaymentPolicyConfig = {
  dailyBudgetUsdc: "10",
  maxSinglePaymentUsdc: "1",
  maxBatchPaymentUsdc: "5",
  hostAllowlist: [],
  requireHttps: true,
  allowLocalhost: false,
  requireGatewayBatching: true,
};

export function envList(value: string | undefined, fallback: string[]): string[] {
  if (!value || !value.trim()) return fallback;
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new ConfigurationError(`Missing required env var: ${name}`);
  return value;
}

export function buyerConfigFromEnv(): BuyerAgentConfig {
  const ledgerPath = process.env.X402_LEDGER_PATH || ".x402-ledger.json";
  return {
    dcw: {
      apiKey: requireEnv("CIRCLE_API_KEY"),
      entitySecret: requireEnv("CIRCLE_ENTITY_SECRET"),
      walletId: requireEnv("CIRCLE_DCW_WALLET_ID"),
      walletAddress: requireEnv("CIRCLE_DCW_WALLET_ADDRESS") as `0x${string}`,
      blockchain: process.env.CIRCLE_DCW_BLOCKCHAIN || "ARC-TESTNET",
      baseUrl: process.env.CIRCLE_API_BASE_URL,
    },
    chain: process.env.X402_CHAIN || "arcTestnet",
    rpcUrl: process.env.ARC_RPC_URL,
    ledger: new FileSpendLedger(ledgerPath),
    policy: {
      dailyBudgetUsdc: process.env.X402_DAILY_BUDGET_USDC || DEFAULT_POLICY.dailyBudgetUsdc,
      maxSinglePaymentUsdc: process.env.X402_MAX_SINGLE_PAYMENT_USDC || DEFAULT_POLICY.maxSinglePaymentUsdc,
      maxBatchPaymentUsdc: process.env.X402_MAX_BATCH_PAYMENT_USDC || DEFAULT_POLICY.maxBatchPaymentUsdc,
      hostAllowlist: envList(process.env.X402_HOST_ALLOWLIST, DEFAULT_POLICY.hostAllowlist),
      allowLocalhost: process.env.X402_ALLOW_LOCALHOST === "true",
    },
  };
}

export function sellerConfigFromEnv(): SellerAgentConfig {
  return {
    sellerAddress: requireEnv("SELLER_ADDRESS") as `0x${string}`,
    facilitatorUrl: process.env.X402_FACILITATOR_URL || "https://gateway-api-testnet.circle.com",
    networks: envList(process.env.X402_NETWORK, ["eip155:5042002"]) as `eip155:${number}`[],
    description: process.env.X402_SELLER_DESCRIPTION || "x402 Arc paid resource",
  };
}
