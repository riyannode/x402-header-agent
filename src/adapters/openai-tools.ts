import { z } from "zod";
import type { BuyerBatchAgent } from "../core/buyer.js";

const moneyString = z.string().regex(/^\d+(\.\d{1,6})?$/);
const payResourceSchema = z.object({
  url: z.string().url(),
  label: z.string().max(128).optional(),
  maxUsdcOverride: moneyString.optional(),
}).strict();
const payBatchSchema = z.object({
  urls: z.array(z.string().url()).min(1).max(50),
  maxUsdcPerResource: moneyString.optional(),
}).strict();
const depositSchema = z.object({
  amountUsdc: moneyString,
  skipApproval: z.boolean().optional(),
  assumeApprovalConfirmed: z.boolean().optional(),
}).strict();
const supportsSchema = z.object({ url: z.string().url() }).strict();

export function getOpenAIToolDefinitions() {
  return [
    {
      type: "function",
      name: "x402_pay_resource",
      description: "Pay one Circle Gateway x402-batched resource on Arc.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["url"],
        properties: {
          url: { type: "string", description: "HTTPS x402-protected resource URL" },
          label: { type: "string", description: "Optional local label for ledger/receipt" },
          maxUsdcOverride: { type: "string", description: "Optional max USDC cap for this resource, e.g. 0.001" },
        },
      },
    },
    {
      type: "function",
      name: "x402_pay_batch",
      description: "Pay multiple Circle Gateway x402-batched resources after one policy preflight.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["urls"],
        properties: {
          urls: { type: "array", minItems: 1, maxItems: 50, items: { type: "string" } },
          maxUsdcPerResource: { type: "string", description: "Optional cap applied to each resource" },
        },
      },
    },
    {
      type: "function",
      name: "x402_gateway_balance",
      description: "Check buyer wallet and Circle Gateway USDC balances.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
    },
    {
      type: "function",
      name: "x402_gateway_deposit",
      description: "Create Circle DCW approval/deposit transactions to fund Gateway balance.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["amountUsdc"],
        properties: {
          amountUsdc: { type: "string" },
          skipApproval: { type: "boolean" },
          assumeApprovalConfirmed: { type: "boolean" },
        },
      },
    },
    {
      type: "function",
      name: "x402_supports",
      description: "Check whether a URL supports Circle Gateway x402 batching before paying.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["url"],
        properties: { url: { type: "string" } },
      },
    },
  ];
}

export async function dispatchOpenAIToolCall(buyer: BuyerBatchAgent, name: string, args: unknown): Promise<string> {
  const raw = typeof args === "string" ? JSON.parse(args) : args;
  if (name === "x402_pay_resource") {
    const parsed = payResourceSchema.parse(raw);
    return JSON.stringify(await buyer.payResource({ url: parsed.url, label: parsed.label, maxUsdcOverride: parsed.maxUsdcOverride }));
  }
  if (name === "x402_pay_batch") {
    const parsed = payBatchSchema.parse(raw);
    return JSON.stringify(await buyer.payBatch({ requests: parsed.urls.map((url) => ({ url, maxUsdcOverride: parsed.maxUsdcPerResource })) }));
  }
  if (name === "x402_gateway_balance") return JSON.stringify(await buyer.getBalances());
  if (name === "x402_gateway_deposit") {
    const parsed = depositSchema.parse(raw);
    return JSON.stringify(await buyer.createGatewayDeposit(parsed.amountUsdc, { skipApproval: parsed.skipApproval, assumeApprovalConfirmed: parsed.assumeApprovalConfirmed }));
  }
  if (name === "x402_supports") {
    const parsed = supportsSchema.parse(raw);
    return JSON.stringify(await buyer.supports(parsed.url));
  }
  throw new Error(`Unknown x402 tool: ${name}`);
}
