import { createHash, randomUUID } from "node:crypto";
import { getAddress, type Address, type Hex } from "viem";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const CircleDcwSdk = require("@circle-fin/developer-controlled-wallets");
import type { CircleBlockchain, CircleDcwConfig, DcwDepositResult } from "./types.js";
import { ConfigurationError, GatewayPaymentError } from "./errors.js";
import { compareUsdc, normalizeUsdc, usdcToBaseUnits } from "../utils/money.js";

export interface Eip712SignParams {
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: Address;
  };
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}

export interface DcwContractExecutionInput {
  contractAddress: Address;
  abiFunctionSignature: string;
  abiParameters: Array<string | number | boolean | string[]>;
  idempotencyKey?: string;
  feeLevel?: "LOW" | "MEDIUM" | "HIGH";
  refId?: string;
}

function ensureHexSignature(signature: string): Hex {
  const value = signature.trim();
  if (/^0x[a-fA-F0-9]{130}$/.test(value)) return value as Hex;
  if (/^[a-fA-F0-9]{130}$/.test(value)) return `0x${value}` as Hex;

  try {
    const decoded = Buffer.from(value, "base64");
    if (decoded.length === 65) return `0x${decoded.toString("hex")}` as Hex;
  } catch {
    // fall through
  }

  throw new GatewayPaymentError("Circle DCW returned an unsupported EVM signature encoding");
}


function deterministicUuid(input: string): string {
  const hex = createHash("sha256").update(input).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, "0")}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}

function redactError(error: unknown): string {
  if (error instanceof Error) {
    return error.message
      .replace(/0x[a-fA-F0-9]{64,}/g, "0x[redacted]")
      .replace(/entitySecret[^\n,]*/gi, "entitySecret[redacted]")
      .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]");
  }
  return String(error);
}

export function toCircleTypedDataJson(params: Eip712SignParams): string {
  return JSON.stringify(params, (_key, value) => {
    if (typeof value === "bigint") return value.toString();
    return value;
  });
}

export class CircleDcwWallet {
  readonly address: Address;
  readonly walletId: string;
  readonly blockchain: CircleBlockchain;
  private readonly client: any;

  constructor(readonly config: CircleDcwConfig) {
    if (!config.apiKey) throw new ConfigurationError("Circle DCW apiKey is required");
    if (!config.entitySecret) throw new ConfigurationError("Circle DCW entitySecret is required");
    if (!config.walletId) throw new ConfigurationError("Circle DCW walletId is required");
    this.address = getAddress(config.walletAddress);
    this.walletId = config.walletId;
    this.blockchain = config.blockchain ?? "ARC-TESTNET";
    this.client = new (CircleDcwSdk as any).CircleDeveloperControlledWalletsClient({
      apiKey: config.apiKey,
      entitySecret: config.entitySecret,
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    });
  }

  async signTypedData(params: Eip712SignParams): Promise<Hex> {
    try {
      const response = await this.client.signTypedData({
        walletId: this.walletId,
        data: toCircleTypedDataJson(params),
        memo: `x402 Gateway authorization ${params.domain.name}`,
      });
      const signature = response.data?.signature;
      if (!signature) throw new GatewayPaymentError("Circle DCW signTypedData response missing signature");
      return ensureHexSignature(signature);
    } catch (error) {
      if (error instanceof GatewayPaymentError) throw error;
      throw new GatewayPaymentError(`Circle DCW signTypedData failed: ${redactError(error)}`, error);
    }
  }

  async executeContract(input: DcwContractExecutionInput): Promise<string> {
    try {
      const response = await this.client.createContractExecutionTransaction({
        idempotencyKey: input.idempotencyKey ?? randomUUID(),
        walletId: this.walletId,
        contractAddress: input.contractAddress,
        abiFunctionSignature: input.abiFunctionSignature,
        abiParameters: input.abiParameters,
        fee: { type: "level", config: { feeLevel: input.feeLevel ?? "MEDIUM" } },
        ...(input.refId ? { refId: input.refId } : {}),
      });
      const txId = response.data?.id;
      if (!txId) throw new GatewayPaymentError("Circle DCW contractExecution response missing transaction id");
      return txId;
    } catch (error) {
      if (error instanceof GatewayPaymentError) throw error;
      throw new GatewayPaymentError(`Circle DCW contractExecution failed: ${redactError(error)}`, error);
    }
  }

  async createGatewayDepositTransactions(params: {
    amountUsdc: string;
    usdcAddress: Address;
    gatewayWalletAddress: Address;
    approveAmountUsdc?: string;
    skipApproval?: boolean;
    assumeApprovalConfirmed?: boolean;
    idempotencyPrefix?: string;
  }): Promise<DcwDepositResult> {
    const amountUsdc = normalizeUsdc(params.amountUsdc);
    const approveAmountUsdc = normalizeUsdc(params.approveAmountUsdc ?? params.amountUsdc);
    if (!params.skipApproval && !params.assumeApprovalConfirmed && compareUsdc(approveAmountUsdc, amountUsdc) < 0) {
      throw new GatewayPaymentError(`Approval amount ${approveAmountUsdc} USDC is below deposit amount ${amountUsdc} USDC`);
    }
    const amountBaseUnits = usdcToBaseUnits(amountUsdc).toString();
    const approveBaseUnits = usdcToBaseUnits(approveAmountUsdc).toString();
    const prefix = params.idempotencyPrefix ?? randomUUID();

    let approvalTransactionId: string | undefined;
    if (!params.skipApproval && !params.assumeApprovalConfirmed) {
      approvalTransactionId = await this.executeContract({
        idempotencyKey: deterministicUuid(`${prefix}:approve`),
        contractAddress: params.usdcAddress,
        abiFunctionSignature: "approve(address,uint256)",
        abiParameters: [params.gatewayWalletAddress, approveBaseUnits],
        refId: `${prefix}:x402-gateway-approve`,
      });
      return {
        approvalTransactionId,
        amountUsdc,
        depositor: this.address,
        nextAction: "wait_for_approval_confirmation",
      };
    }

    const depositTransactionId = await this.executeContract({
      idempotencyKey: deterministicUuid(`${prefix}:deposit`),
      contractAddress: params.gatewayWalletAddress,
      abiFunctionSignature: "depositFor(address,address,uint256)",
      abiParameters: [params.usdcAddress, this.address, amountBaseUnits],
      refId: `${prefix}:x402-gateway-depositFor`,
    });

    return {
      approvalTransactionId,
      depositTransactionId,
      amountUsdc,
      depositor: this.address,
      nextAction: "track_deposit_confirmation",
    };
  }
}
