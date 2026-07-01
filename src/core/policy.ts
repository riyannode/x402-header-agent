import type { PaymentPolicyConfig, PayResourceInput, SpendLedger } from "./types.js";
import { PolicyViolation } from "./errors.js";
import { compareUsdc, sumUsdc } from "../utils/money.js";
import { hostMatchesAllowlist, isLocalhost, isPrivateHost, parsePaymentUrl, resolvesToPrivateHost } from "../utils/url.js";
import { DEFAULT_POLICY } from "./config.js";

export class PaymentPolicy {
  readonly config: PaymentPolicyConfig;

  constructor(config: Partial<PaymentPolicyConfig> = {}) {
    this.config = {
      ...DEFAULT_POLICY,
      ...config,
      hostAllowlist: config.hostAllowlist ?? DEFAULT_POLICY.hostAllowlist,
    };
  }

  validateUrl(url: string): URL {
    const parsed = parsePaymentUrl(url);
    if (this.config.requireHttps && parsed.protocol !== "https:") {
      const local = isLocalhost(parsed.hostname);
      if (!(this.config.allowLocalhost && local && parsed.protocol === "http:")) {
        throw new PolicyViolation(`Payment URL must use HTTPS: ${url}`);
      }
    }
    if (!this.config.allowLocalhost && isPrivateHost(parsed.hostname)) {
      throw new PolicyViolation(`Private/local payment hosts are blocked by policy: ${parsed.hostname}`);
    }
    if (!hostMatchesAllowlist(parsed.hostname, this.config.hostAllowlist)) {
      throw new PolicyViolation(`Host is not in X402_HOST_ALLOWLIST: ${parsed.hostname}`);
    }
    return parsed;
  }


  async validateNetworkTarget(url: string): Promise<URL> {
    const parsed = this.validateUrl(url);
    if (!this.config.allowLocalhost && await resolvesToPrivateHost(parsed.hostname)) {
      throw new PolicyViolation(`Payment host resolves to a private/local address and is blocked by policy: ${parsed.hostname}`);
    }
    return parsed;
  }

  validateSinglePayment(amountUsdc: string, url: string): void {
    this.validateUrl(url);
    if (compareUsdc(amountUsdc, this.config.maxSinglePaymentUsdc) > 0) {
      throw new PolicyViolation(`Payment ${amountUsdc} USDC exceeds max single payment ${this.config.maxSinglePaymentUsdc} USDC`);
    }
  }

  async validateDailyBudget(params: {
    walletAddress: string;
    ledger: SpendLedger;
    plannedAmountsUsdc: string[];
    now?: Date;
  }): Promise<void> {
    const day = (params.now ?? new Date()).toISOString().slice(0, 10);
    const spent = await params.ledger.getDailySpend(params.walletAddress, day);
    const planned = sumUsdc(params.plannedAmountsUsdc);
    const total = sumUsdc([spent, planned]);
    if (compareUsdc(total, this.config.dailyBudgetUsdc) > 0) {
      throw new PolicyViolation(`Daily budget exceeded: spent=${spent}, planned=${planned}, limit=${this.config.dailyBudgetUsdc} USDC`);
    }
  }

  async validateBatch(params: {
    walletAddress: string;
    ledger: SpendLedger;
    inputs: PayResourceInput[];
    plannedAmountsUsdc: string[];
  }): Promise<void> {
    if (params.inputs.length !== params.plannedAmountsUsdc.length) {
      throw new PolicyViolation("Batch policy input mismatch");
    }
    params.inputs.forEach((input, index) => this.validateSinglePayment(params.plannedAmountsUsdc[index]!, input.url));
    const batchTotal = sumUsdc(params.plannedAmountsUsdc);
    if (compareUsdc(batchTotal, this.config.maxBatchPaymentUsdc) > 0) {
      throw new PolicyViolation(`Batch total ${batchTotal} USDC exceeds max batch payment ${this.config.maxBatchPaymentUsdc} USDC`);
    }
    await this.validateDailyBudget({
      walletAddress: params.walletAddress,
      ledger: params.ledger,
      plannedAmountsUsdc: params.plannedAmountsUsdc,
    });
  }
}
