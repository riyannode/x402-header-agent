import type { BatchPayInput, BatchPaymentResult, PayResourceInput } from "../core/types.js";
import { BuyerBatchAgent } from "../core/buyer.js";

export interface BatchPlanItem extends PayResourceInput {
  expectedUsdc?: string;
}

export interface BatchPlan {
  items: BatchPlanItem[];
  maxConcurrency?: number;
  stopOnAnyUnsupported?: boolean;
}

export async function runBuyerBatchPlan(buyer: BuyerBatchAgent, plan: BatchPlan): Promise<BatchPaymentResult> {
  const input: BatchPayInput = {
    requests: plan.items.map((item) => ({
      url: item.url,
      requestInit: item.requestInit,
      label: item.label,
      maxUsdcOverride: item.expectedUsdc ?? item.maxUsdcOverride,
      metadata: item.metadata,
    })),
    concurrency: plan.maxConcurrency ?? 4,
    failFast: plan.stopOnAnyUnsupported ?? true,
  };
  return buyer.payBatch(input);
}
