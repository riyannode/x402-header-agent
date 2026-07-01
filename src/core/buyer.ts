import { BatchEvmScheme, CHAIN_CONFIGS, arcPrivateMainnetHeaders, type SupportedChainName } from "@circle-fin/x402-batching/client";
import type { HookSettleResponse } from "@circle-fin/x402-batching";
import { randomUUID } from "node:crypto";
import { createPublicClient, erc20Abi, formatUnits, http, parseUnits, type Address } from "viem";
import type {
  BalanceSnapshot,
  BatchPayInput,
  BatchPaymentResult,
  BuyerAgentConfig,
  DcwDepositResult,
  PayResourceInput,
  PaymentReceipt,
  SpendLedger,
  SupportProbe,
} from "./types.js";
import { CircleDcwWallet } from "./dcw-wallet.js";
import { InMemorySpendLedger } from "./ledger.js";
import { PaymentPolicy } from "./policy.js";
import { ConfigurationError, GatewayPaymentError, PolicyViolation, UnsupportedPaymentError } from "./errors.js";
import { baseUnitsToUsdc, compareUsdc, normalizeUsdc, sumUsdc } from "../utils/money.js";
import { parsePaymentUrl } from "../utils/url.js";

const GATEWAY_API_TESTNET = "https://gateway-api-testnet.circle.com/v1";
const GATEWAY_API_MAINNET = "https://gateway-api.circle.com/v1";
const MAX_PAYMENT_HEADER_BYTES = 64 * 1024;

function randomId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

function redactError(error: unknown): string {
  if (error instanceof Error) {
    return error.message
      .replace(/0x[a-fA-F0-9]{64,}/g, "0x[redacted]")
      .replace(/Payment-Signature:\s*[^\n]+/gi, "Payment-Signature: [redacted]")
      .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]");
  }
  return String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function pickAmountFromRequirements(requirements: unknown): string | undefined {
  const req = requirements as any;
  const candidate = req?.amount
    ?? req?.accepted?.amount
    ?? req?.accepts?.find?.((item: any) => item?.extra?.name === "GatewayWalletBatched")?.amount
    ?? req?.accepts?.[0]?.amount;
  if (candidate === undefined || candidate === null) return undefined;
  try {
    return baseUnitsToUsdc(String(candidate));
  } catch {
    return undefined;
  }
}

function pickNetworkFromData(data: unknown): string | undefined {
  const obj = data as any;
  return obj?.network ?? obj?.payment?.network ?? obj?.settlement?.network;
}

function pickTransactionFromData(data: unknown): string | undefined {
  const obj = data as any;
  return obj?.transaction ?? obj?.payment?.transaction ?? obj?.settlement?.transaction ?? obj?.txHash;
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) return undefined;
  return response.json().catch(() => undefined);
}

function decodePaymentHeaderJson(header: string, name: string): unknown {
  if (Buffer.byteLength(header, "utf8") > MAX_PAYMENT_HEADER_BYTES) {
    throw new GatewayPaymentError(`${name} header exceeds ${MAX_PAYMENT_HEADER_BYTES} bytes`);
  }
  try {
    return JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    throw new GatewayPaymentError(`Invalid ${name} header`);
  }
}

function stringifyJsonSafe(value: unknown): string {
  return JSON.stringify(value, (_key, inner) => typeof inner === "bigint" ? inner.toString() : inner);
}

function sanitizedPaymentHeaders(headers?: HeadersInit): Headers {
  const out = new Headers(headers);
  out.delete("Payment-Signature");
  out.delete("PAYMENT-SIGNATURE");
  out.delete("Payment-Required");
  out.delete("PAYMENT-REQUIRED");
  out.delete("Payment-Response");
  out.delete("PAYMENT-RESPONSE");
  return out;
}

function amountFromProbeOrThrow(probe: SupportProbe, url: string): string {
  if (!probe.supported || !probe.amountUsdc) {
    throw new UnsupportedPaymentError(`Batch preflight failed for ${url}`, probe.error);
  }
  return normalizeUsdc(probe.amountUsdc);
}

function enforceOptionalCap(actualUsdc: string, maxUsdcOverride: string | undefined, url: string): void {
  if (!maxUsdcOverride) return;
  const cap = normalizeUsdc(maxUsdcOverride);
  if (compareUsdc(actualUsdc, cap) > 0) {
    throw new PolicyViolation(`Seller price ${actualUsdc} USDC exceeds caller cap ${cap} USDC for ${url}`);
  }
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const safeConcurrency = Math.max(1, Math.min(concurrency, 16));
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(safeConcurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

function isTestnetChain(chain: SupportedChainName): boolean {
  return chain.toLowerCase().includes("testnet") || chain.toLowerCase().includes("sepolia") || chain.toLowerCase().includes("fuji") || chain.toLowerCase().includes("amoy");
}

export class BuyerBatchAgent {
  readonly policy: PaymentPolicy;
  readonly ledger: SpendLedger;
  readonly address: Address;
  readonly chain: SupportedChainName;
  readonly dcw: CircleDcwWallet;
  readonly batchScheme: BatchEvmScheme;
  private readonly chainConfig: (typeof CHAIN_CONFIGS)[SupportedChainName];
  private readonly publicClient: ReturnType<typeof createPublicClient>;
  private readonly arcPrivateMainnet: boolean;

  constructor(config: BuyerAgentConfig) {
    this.chain = (config.chain ?? "arcTestnet") as SupportedChainName;
    const chainConfig = CHAIN_CONFIGS[this.chain];
    if (!chainConfig) throw new ConfigurationError(`Unsupported Circle Gateway chain: ${this.chain}`);
    this.chainConfig = chainConfig;
    this.arcPrivateMainnet = this.chain === "arc";
    this.dcw = new CircleDcwWallet(config.dcw);
    this.address = this.dcw.address;
    this.batchScheme = new BatchEvmScheme({
      address: this.address,
      signTypedData: (params) => this.dcw.signTypedData(params),
    });
    this.publicClient = createPublicClient({
      chain: chainConfig.chain,
      transport: config.rpcUrl ? http(config.rpcUrl) : http(chainConfig.rpcUrl),
    });
    this.policy = new PaymentPolicy(config.policy);
    this.ledger = config.ledger ?? new InMemorySpendLedger();
  }

  private gatewayApiBaseUrl(): string {
    return isTestnetChain(this.chain) ? GATEWAY_API_TESTNET : GATEWAY_API_MAINNET;
  }

  private gatewayApiHeaders(): Record<string, string> {
    return arcPrivateMainnetHeaders(this.arcPrivateMainnet);
  }

  private expectedNetwork(): string {
    return `eip155:${this.chainConfig.chain.id}`;
  }

  private selectBatchingRequirement(paymentRequired: unknown): Record<string, unknown> | undefined {
    if (!isRecord(paymentRequired)) return undefined;
    const accepts = paymentRequired.accepts;
    if (!Array.isArray(accepts)) return undefined;
    const expectedNetwork = this.expectedNetwork();
    return accepts.find((opt) => {
      if (!isRecord(opt)) return false;
      const extra = opt.extra;
      return opt.network === expectedNetwork
        && isRecord(extra)
        && extra.name === "GatewayWalletBatched"
        && extra.version === "1"
        && typeof extra.verifyingContract === "string";
    }) as Record<string, unknown> | undefined;
  }

  private async fetchPaymentRequired(url: string, init?: RequestInit): Promise<{ response: Response; paymentRequired?: unknown; batchingRequirement?: Record<string, unknown> }> {
    const response = await fetch(url, { ...init, redirect: "manual" });
    if (response.status !== 402) return { response };
    const paymentRequiredHeader = response.headers.get("PAYMENT-REQUIRED");
    if (!paymentRequiredHeader) {
      throw new UnsupportedPaymentError("Missing PAYMENT-REQUIRED header in 402 response");
    }
    const paymentRequired = decodePaymentHeaderJson(paymentRequiredHeader, "PAYMENT-REQUIRED");
    const batchingRequirement = this.selectBatchingRequirement(paymentRequired);
    return { response, paymentRequired, batchingRequirement };
  }

  async getBalances(): Promise<BalanceSnapshot> {
    const [walletBalance, gatewayBalance] = await Promise.all([
      this.publicClient.readContract({
        address: this.chainConfig.usdc,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [this.address],
      }) as Promise<bigint>,
      this.getGatewayBalance(),
    ]);
    return {
      walletUsdc: formatUnits(walletBalance, 6),
      gatewayAvailableUsdc: gatewayBalance.formattedAvailable,
      gatewayTotalUsdc: gatewayBalance.formattedTotal,
      raw: { gateway: gatewayBalance },
    };
  }

  async getGatewayBalance(address: Address = this.address): Promise<{ total: bigint; available: bigint; withdrawing: bigint; withdrawable: bigint; formattedTotal: string; formattedAvailable: string; formattedWithdrawing: string; formattedWithdrawable: string }> {
    const response = await fetch(`${this.gatewayApiBaseUrl()}/balances`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.gatewayApiHeaders() },
      body: JSON.stringify({ token: "USDC", sources: [{ depositor: address, domain: this.chainConfig.domain }] }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new GatewayPaymentError(`Gateway balance fetch failed: ${data?.message ?? response.statusText}`);
    if (!Array.isArray(data?.balances) || data.balances.length === 0) throw new GatewayPaymentError("Gateway returned no balances for depositor");
    const row = data.balances[0];
    const available = parseUnits(String(row.balance ?? "0"), 6);
    const withdrawing = parseUnits(String(row.withdrawing ?? "0"), 6);
    const withdrawable = parseUnits(String(row.withdrawable ?? "0"), 6);
    const total = available + withdrawing;
    return {
      total,
      available,
      withdrawing,
      withdrawable,
      formattedTotal: formatUnits(total, 6),
      formattedAvailable: formatUnits(available, 6),
      formattedWithdrawing: formatUnits(withdrawing, 6),
      formattedWithdrawable: formatUnits(withdrawable, 6),
    };
  }

  async createGatewayDeposit(amountUsdc: string, options: { approveAmountUsdc?: string; skipApproval?: boolean; assumeApprovalConfirmed?: boolean; idempotencyPrefix?: string } = {}): Promise<DcwDepositResult> {
    return this.dcw.createGatewayDepositTransactions({
      amountUsdc: normalizeUsdc(amountUsdc),
      approveAmountUsdc: options.approveAmountUsdc,
      skipApproval: options.skipApproval,
      assumeApprovalConfirmed: options.assumeApprovalConfirmed,
      idempotencyPrefix: options.idempotencyPrefix,
      usdcAddress: this.chainConfig.usdc,
      gatewayWalletAddress: this.chainConfig.gatewayWallet,
    });
  }

  async ensureGatewayBalance(minAvailableUsdc: string): Promise<BalanceSnapshot> {
    const min = normalizeUsdc(minAvailableUsdc);
    const before = await this.getBalances();
    if (compareUsdc(before.gatewayAvailableUsdc, min) >= 0) return before;
    throw new PolicyViolation(`Gateway balance too low: available=${before.gatewayAvailableUsdc}, required=${min}. Call createGatewayDeposit() with Circle DCW before paying.`);
  }


  private async reservePaymentBudget(params: { id: string; url: string; host: string; amountUsdc: string; label?: string }): Promise<void> {
    const createdAt = new Date().toISOString();
    const record = {
      id: params.id,
      walletAddress: this.address,
      url: params.url,
      host: params.host,
      amountUsdc: params.amountUsdc,
      status: "reserved" as const,
      createdAt,
      label: params.label,
    };
    if (this.ledger.reservePayment) {
      await this.ledger.reservePayment(record, this.policy.config.dailyBudgetUsdc, createdAt.slice(0, 10));
      return;
    }
    await this.policy.validateDailyBudget({ walletAddress: this.address, ledger: this.ledger, plannedAmountsUsdc: [params.amountUsdc], now: new Date(createdAt) });
    await this.ledger.recordPayment(record);
  }

  private async finalizeReservedPayment(params: { id: string; url: string; host: string; amountUsdc: string; status: "success" | "failed"; createdAt: string; label?: string; transaction?: string }): Promise<void> {
    await this.ledger.recordPayment({
      id: params.id,
      walletAddress: this.address,
      url: params.url,
      host: params.host,
      amountUsdc: params.amountUsdc,
      status: params.status,
      transaction: params.transaction,
      createdAt: params.createdAt,
      label: params.label,
    });
  }

  async supports(url: string, init?: RequestInit): Promise<SupportProbe> {
    let host = "";
    try {
      const parsed = await this.policy.validateNetworkTarget(url);
      host = parsed.hostname;
      const method = init?.method ?? "GET";
      const headers = sanitizedPaymentHeaders(init?.headers);
      if (!headers.has("content-type") && init?.body !== undefined) headers.set("content-type", "application/json");
      const { response, batchingRequirement } = await this.fetchPaymentRequired(url, { ...init, method, headers });
      if (response.status !== 402) return { supported: false, url, host, error: "Resource does not require payment (not 402)" };
      if (!batchingRequirement) return { supported: false, url, host, error: `No GatewayWalletBatched option for ${this.expectedNetwork()}` };
      return {
        supported: true,
        url,
        host,
        amountUsdc: pickAmountFromRequirements(batchingRequirement),
        rawRequirements: batchingRequirement,
      };
    } catch (error) {
      return { supported: false, url, host, error: redactError(error) };
    }
  }

  async preflight(input: PayResourceInput): Promise<SupportProbe> {
    const probe = await this.supports(input.url, input.requestInit);
    if (!probe.supported) throw new UnsupportedPaymentError(`URL does not advertise Circle Gateway batching support: ${input.url}`, probe.error);
    const plannedAmount = amountFromProbeOrThrow(probe, input.url);
    enforceOptionalCap(plannedAmount, input.maxUsdcOverride, input.url);
    this.policy.validateSinglePayment(plannedAmount, input.url);
    await this.policy.validateDailyBudget({ walletAddress: this.address, ledger: this.ledger, plannedAmountsUsdc: [plannedAmount] });
    await this.ensureGatewayBalance(plannedAmount);
    return { ...probe, amountUsdc: plannedAmount };
  }

  async payResource(input: PayResourceInput): Promise<PaymentReceipt> {
    const id = randomId("pay");
    let parsed: URL | undefined;
    let amountUsdc = "0";
    let reserved = false;
    try {
      parsed = await this.policy.validateNetworkTarget(input.url);
      const preflight = await this.preflight(input);
      amountUsdc = preflight.amountUsdc ?? "0";
      const method = input.requestInit?.method ?? "GET";
      const originalHeaders = sanitizedPaymentHeaders(input.requestInit?.headers);
      if (!originalHeaders.has("content-type") && input.requestInit?.body !== undefined) originalHeaders.set("content-type", "application/json");
      const body = input.requestInit?.body;
      const { response, paymentRequired, batchingRequirement } = await this.fetchPaymentRequired(input.url, {
        ...input.requestInit,
        method,
        headers: originalHeaders,
        body,
      });
      if (response.status !== 402) {
        const data = await parseJsonResponse(response);
        if (!response.ok) throw new GatewayPaymentError(`Request failed before payment: HTTP ${response.status}`);
        return {
          id,
          status: "success",
          url: input.url,
          host: parsed?.hostname ?? "",
          amountUsdc: "0",
          httpStatus: response.status,
          data,
          createdAt: new Date().toISOString(),
          label: input.label,
          metadata: input.metadata,
        };
      }
      if (!paymentRequired || !batchingRequirement) throw new UnsupportedPaymentError(`No Gateway batching option available for ${this.expectedNetwork()}`);

      const x402Version = Number((paymentRequired as any).x402Version ?? 2);
      const liveAmountUsdc = baseUnitsToUsdc(String(batchingRequirement.amount));
      enforceOptionalCap(liveAmountUsdc, input.maxUsdcOverride, input.url);
      this.policy.validateSinglePayment(liveAmountUsdc, input.url);
      await this.ensureGatewayBalance(liveAmountUsdc);
      amountUsdc = liveAmountUsdc;
      await this.reservePaymentBudget({ id, url: input.url, host: parsed?.hostname ?? "", amountUsdc, label: input.label });
      reserved = true;
      const amount = BigInt(String(batchingRequirement.amount));

      for (let attempt = 0; attempt < 2; attempt++) {
        const paymentPayload = await this.batchScheme.createPaymentPayload(x402Version, batchingRequirement as any);
        const paymentHeader = Buffer.from(stringifyJsonSafe({
          ...paymentPayload,
          resource: (paymentRequired as any).resource,
          accepted: batchingRequirement,
        })).toString("base64");
        const paidHeaders = new Headers(originalHeaders);
        paidHeaders.set("Payment-Signature", paymentHeader);
        const paidResponse = await fetch(input.url, {
          ...input.requestInit,
          redirect: "manual",
          method,
          headers: paidHeaders,
          body,
        });
        const paymentResponseHeader = paidResponse.headers.get("PAYMENT-RESPONSE");
        const settleResponse = paymentResponseHeader
          ? (decodePaymentHeaderJson(paymentResponseHeader, "PAYMENT-RESPONSE") as HookSettleResponse | undefined)
          : undefined;
        const recovery = await this.batchScheme.dispatchPaymentResponse({
          paymentPayload: { x402Version: paymentPayload.x402Version, payload: paymentPayload.payload as unknown as Record<string, unknown> },
          requirements: batchingRequirement as any,
          paymentRequired: paymentRequired as any,
          settleResponse,
          error: paidResponse.ok ? undefined : new Error(`Payment failed with HTTP ${paidResponse.status}`),
        });
        if (recovery?.recovered && attempt === 0) continue;
        if (!paidResponse.ok) {
          const errBody = await parseJsonResponse(paidResponse);
          throw new GatewayPaymentError(`Payment failed: HTTP ${paidResponse.status} ${isRecord(errBody) && typeof errBody.error === "string" ? errBody.error : paidResponse.statusText}`);
        }
        const data = await parseJsonResponse(paidResponse);
        const paidUsdc = baseUnitsToUsdc(amount);
        const receipt: PaymentReceipt = {
          id,
          status: "success",
          url: input.url,
          host: parsed?.hostname ?? "",
          amountUsdc: paidUsdc,
          network: pickNetworkFromData(settleResponse) ?? String(batchingRequirement.network ?? ""),
          payer: this.address,
          transaction: pickTransactionFromData(settleResponse),
          httpStatus: paidResponse.status,
          data,
          createdAt: new Date().toISOString(),
          label: input.label,
          metadata: input.metadata,
        };
        await this.finalizeReservedPayment({
          id,
          url: input.url,
          host: parsed?.hostname ?? "",
          amountUsdc: receipt.amountUsdc,
          status: "success",
          transaction: receipt.transaction,
          createdAt: receipt.createdAt,
          label: input.label,
        });
        return receipt;
      }
      throw new GatewayPaymentError("Payment retry exhausted");
    } catch (error) {
      const status = error instanceof PolicyViolation ? "rejected" : error instanceof UnsupportedPaymentError ? "unsupported" : "failed";
      const receipt: PaymentReceipt = {
        id,
        status,
        url: input.url,
        host: parsed?.hostname ?? "",
        amountUsdc,
        error: redactError(error),
        createdAt: new Date().toISOString(),
        label: input.label,
        metadata: input.metadata,
      };
      if (reserved) {
        await this.finalizeReservedPayment({
          id,
          url: input.url,
          host: parsed?.hostname ?? "",
          amountUsdc,
          status: "failed",
          createdAt: receipt.createdAt,
          label: input.label,
        });
      }
      return receipt;
    }
  }

  async payBatch(input: BatchPayInput): Promise<BatchPaymentResult> {
    const id = randomId("batch");
    const createdAt = new Date().toISOString();
    if (!input.requests.length) return { id, status: "rejected", plannedTotalUsdc: "0", paidTotalUsdc: "0", receipts: [], createdAt };
    if (input.requests.length > 50) {
      return { id, status: "rejected", plannedTotalUsdc: "0", paidTotalUsdc: "0", receipts: [], createdAt, error: "Batch request limit exceeded: max 50 resources" };
    }

    try {
      const probes = await Promise.all(input.requests.map((request) => this.supports(request.url, request.requestInit)));
      const plannedAmounts = probes.map((probe, index) => {
        const request = input.requests[index]!;
        const actualAmount = amountFromProbeOrThrow(probe, request.url);
        enforceOptionalCap(actualAmount, request.maxUsdcOverride, request.url);
        return actualAmount;
      });
      await this.policy.validateBatch({ walletAddress: this.address, ledger: this.ledger, inputs: input.requests, plannedAmountsUsdc: plannedAmounts });
      await this.ensureGatewayBalance(sumUsdc(plannedAmounts));

      const pinnedRequests = input.requests.map((request, index) => ({
        ...request,
        maxUsdcOverride: plannedAmounts[index]!,
      }));
      const receipts = await mapWithConcurrency(pinnedRequests, input.concurrency ?? 4, async (request) => this.payResource(request));
      const paidTotalUsdc = sumUsdc(receipts.filter((receipt) => receipt.status === "success").map((receipt) => receipt.amountUsdc));
      const failures = receipts.filter((receipt) => receipt.status !== "success");
      return {
        id,
        status: failures.length === 0 ? "success" : receipts.some((receipt) => receipt.status === "success") ? "partial" : "failed",
        plannedTotalUsdc: sumUsdc(plannedAmounts),
        paidTotalUsdc,
        receipts,
        createdAt,
      };
    } catch (error) {
      return {
        id,
        status: "rejected",
        plannedTotalUsdc: "0",
        paidTotalUsdc: "0",
        receipts: [],
        createdAt,
        error: redactError(error),
      };
    }
  }
}

export function createBuyerBatchAgent(config: BuyerAgentConfig): BuyerBatchAgent {
  return new BuyerBatchAgent(config);
}
