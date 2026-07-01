import { z } from "zod";
import type { BuyerBatchAgent } from "../core/buyer.js";

export interface CrewAIStyleTool {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
  run(input: unknown): Promise<string>;
}

const payResourceSchema = z.object({
  url: z.string().url(),
  label: z.string().optional(),
  maxUsdcOverride: z.string().regex(/^\d+(\.\d{1,6})?$/).optional(),
});

const payBatchSchema = z.object({
  urls: z.array(z.string().url()).min(1).max(50),
  maxUsdcPerResource: z.string().regex(/^\d+(\.\d{1,6})?$/).optional(),
});

const depositSchema = z.object({
  amountUsdc: z.string().regex(/^\d+(\.\d{1,6})?$/),
  skipApproval: z.boolean().optional(),
  assumeApprovalConfirmed: z.boolean().optional(),
});

export function getCrewAIStyleBuyerTools(buyer: BuyerBatchAgent): CrewAIStyleTool[] {
  return [
    {
      name: "x402_pay_resource",
      description: "Pay one Circle Gateway x402-batched resource using Circle DCW. No raw buyer private key.",
      schema: payResourceSchema,
      async run(input: unknown) {
        const parsed = payResourceSchema.parse(input);
        return JSON.stringify(await buyer.payResource(parsed));
      },
    },
    {
      name: "x402_pay_batch",
      description: "Pay multiple Circle Gateway x402-batched resources after fail-closed preflight and budget checks.",
      schema: payBatchSchema,
      async run(input: unknown) {
        const parsed = payBatchSchema.parse(input);
        return JSON.stringify(await buyer.payBatch({
          requests: parsed.urls.map((url) => ({ url, maxUsdcOverride: parsed.maxUsdcPerResource })),
        }));
      },
    },
    {
      name: "x402_gateway_balance",
      description: "Check Circle DCW wallet USDC and Circle Gateway available balance.",
      schema: z.object({}),
      async run() {
        return JSON.stringify(await buyer.getBalances());
      },
    },
    {
      name: "x402_gateway_deposit",
      description: "Create Circle DCW approval/deposit transactions to fund Gateway balance.",
      schema: depositSchema,
      async run(input: unknown) {
        const parsed = depositSchema.parse(input);
        return JSON.stringify(await buyer.createGatewayDeposit(parsed.amountUsdc, {
          skipApproval: parsed.skipApproval,
          assumeApprovalConfirmed: parsed.assumeApprovalConfirmed,
        }));
      },
    },
    {
      name: "x402_supports",
      description: "Probe whether a URL supports Circle Gateway x402 batching before paying.",
      schema: z.object({ url: z.string().url() }),
      async run(input: unknown) {
        const parsed = z.object({ url: z.string().url() }).parse(input);
        return JSON.stringify(await buyer.supports(parsed.url));
      },
    },
  ];
}
