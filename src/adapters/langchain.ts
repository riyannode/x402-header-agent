import { z } from "zod";
import type { BuyerBatchAgent } from "../core/buyer.js";

async function optionalImport<T = any>(specifier: string): Promise<T> {
  const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<T>;
  return dynamicImport(specifier);
}

export async function getLangChainBuyerTools(buyer: BuyerBatchAgent): Promise<any[]> {
  let langchainTools: { tool: any };
  try {
    langchainTools = await optionalImport("@langchain/core/tools");
  } catch {
    throw new Error("Install optional peer dependency first: npm install @langchain/core");
  }
  const { tool } = langchainTools;

  const payResource = tool(
    async ({ url, label, maxUsdcOverride }: { url: string; label?: string; maxUsdcOverride?: string }) => JSON.stringify(await buyer.payResource({ url, label, maxUsdcOverride })),
    {
      name: "x402_pay_resource",
      description: "Pay one Circle Gateway x402-batched resource on Arc using Circle DCW. Fails closed if policy, budget, allowlist, balance, or Gateway support checks fail.",
      schema: z.object({
        url: z.string().url(),
        label: z.string().optional(),
        maxUsdcOverride: z.string().regex(/^\d+(\.\d{1,6})?$/).optional(),
      }),
    },
  );

  const payBatch = tool(
    async ({ urls, maxUsdcPerResource }: { urls: string[]; maxUsdcPerResource?: string }) => JSON.stringify(await buyer.payBatch({ requests: urls.map((url) => ({ url, maxUsdcOverride: maxUsdcPerResource })) })),
    {
      name: "x402_pay_batch",
      description: "Pay multiple x402 resources through Circle Gateway batched nanopayments. Performs preflight before sending payment signatures.",
      schema: z.object({ urls: z.array(z.string().url()).min(1).max(50), maxUsdcPerResource: z.string().regex(/^\d+(\.\d{1,6})?$/).optional() }),
    },
  );

  const balance = tool(
    async () => JSON.stringify(await buyer.getBalances()),
    {
      name: "x402_gateway_balance",
      description: "Check buyer DCW wallet and Circle Gateway USDC balances.",
      schema: z.object({}),
    },
  );


  const deposit = tool(
    async ({ amountUsdc, skipApproval, assumeApprovalConfirmed }: { amountUsdc: string; skipApproval?: boolean; assumeApprovalConfirmed?: boolean }) => JSON.stringify(await buyer.createGatewayDeposit(amountUsdc, { skipApproval, assumeApprovalConfirmed })),
    {
      name: "x402_gateway_deposit",
      description: "Create Circle DCW approval/deposit transactions to fund Gateway balance.",
      schema: z.object({
        amountUsdc: z.string().regex(/^\d+(\.\d{1,6})?$/),
        skipApproval: z.boolean().optional(),
        assumeApprovalConfirmed: z.boolean().optional(),
      }),
    },
  );

  const supports = tool(
    async ({ url }: { url: string }) => JSON.stringify(await buyer.supports(url)),
    {
      name: "x402_supports",
      description: "Probe whether a URL supports Circle Gateway x402 batching before paying.",
      schema: z.object({ url: z.string().url() }),
    },
  );

  return [payResource, payBatch, balance, deposit, supports];
}
