export type SupportedChain = "arcTestnet" | "baseSepolia" | (string & {});
export type CircleBlockchain = "ARC-TESTNET" | "BASE-SEPOLIA" | "ETH-SEPOLIA" | "EVM-TESTNET" | (string & {});
export type Caip2Network = `eip155:${number}` | (string & {});
export type Hex = `0x${string}`;

export interface CircleDcwConfig {
  apiKey: string;
  entitySecret: string;
  walletId: string;
  walletAddress: Hex;
  blockchain?: CircleBlockchain;
  baseUrl?: string;
}

export interface BuyerAgentConfig {
  dcw: CircleDcwConfig;
  chain?: SupportedChain;
  rpcUrl?: string;
  policy?: Partial<PaymentPolicyConfig>;
  ledger?: SpendLedger;
}

export interface SellerAgentConfig {
  sellerAddress: Hex;
  facilitatorUrl?: string;
  networks?: Caip2Network[];
  description?: string;
}

export interface PaymentPolicyConfig {
  dailyBudgetUsdc: string;
  maxSinglePaymentUsdc: string;
  maxBatchPaymentUsdc: string;
  hostAllowlist: string[];
  requireHttps: boolean;
  allowLocalhost: boolean;
  requireGatewayBatching: boolean;
}

export interface PayResourceInput {
  url: string;
  requestInit?: RequestInit;
  label?: string;
  maxUsdcOverride?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface BatchPayInput {
  requests: PayResourceInput[];
  concurrency?: number;
  failFast?: boolean;
}

export type PaymentStatus = "reserved" | "success" | "failed" | "rejected" | "unsupported";

export interface PaymentReceipt {
  id: string;
  status: PaymentStatus;
  url: string;
  host: string;
  amountUsdc: string;
  network?: string;
  payer?: string;
  transaction?: string;
  httpStatus?: number;
  data?: unknown;
  error?: string;
  createdAt: string;
  label?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface BatchPaymentResult {
  id: string;
  status: "success" | "partial" | "failed" | "rejected";
  plannedTotalUsdc: string;
  paidTotalUsdc: string;
  receipts: PaymentReceipt[];
  createdAt: string;
  error?: string;
}

export interface SupportProbe {
  supported: boolean;
  url: string;
  host: string;
  amountUsdc?: string;
  rawRequirements?: unknown;
  error?: string;
}

export interface BalanceSnapshot {
  walletUsdc: string;
  gatewayAvailableUsdc: string;
  gatewayTotalUsdc?: string;
  raw?: unknown;
}

export interface DcwDepositResult {
  approvalTransactionId?: string;
  depositTransactionId?: string;
  amountUsdc: string;
  depositor: Hex;
  nextAction?: "wait_for_approval_confirmation" | "track_deposit_confirmation";
}

export interface LedgerPaymentRecord {
  id: string;
  walletAddress: string;
  url: string;
  host: string;
  amountUsdc: string;
  status: PaymentStatus;
  transaction?: string;
  createdAt: string;
  label?: string;
}

export interface SpendLedger {
  getDailySpend(walletAddress: string, dayIso: string): Promise<string>;
  recordPayment(record: LedgerPaymentRecord): Promise<void>;
  reservePayment?(record: LedgerPaymentRecord, dailyBudgetUsdc: string, dayIso: string): Promise<void>;
}

export interface RoutePaymentConfig {
  priceUsdc: string | number;
  description?: string;
}

export interface SellerPaymentInfo {
  verified: boolean;
  payer: string;
  amount: string;
  network: string;
  transaction?: string;
}

export interface WithdrawInput {
  amountUsdc: string;
  chain?: SupportedChain;
  recipient?: Hex;
}
