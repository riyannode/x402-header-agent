import type { BatchPayInput, BuyerAgentConfig, PayResourceInput } from "../core/types.js";
import { BuyerBatchAgent } from "../core/buyer.js";

export interface BuyerAgentToolset {
  x402_pay_resource(input: PayResourceInput): Promise<string>;
  x402_pay_batch(input: BatchPayInput): Promise<string>;
  x402_gateway_balance(): Promise<string>;
  x402_supports(url: string): Promise<string>;
}

export class X402BuyerAgentTools implements BuyerAgentToolset {
  constructor(readonly buyer: BuyerBatchAgent) {}

  async x402_pay_resource(input: PayResourceInput): Promise<string> {
    const receipt = await this.buyer.payResource(input);
    return JSON.stringify(receipt);
  }

  async x402_pay_batch(input: BatchPayInput): Promise<string> {
    const result = await this.buyer.payBatch(input);
    return JSON.stringify(result);
  }

  async x402_gateway_balance(): Promise<string> {
    const balances = await this.buyer.getBalances();
    return JSON.stringify(balances);
  }

  async x402_supports(url: string): Promise<string> {
    const support = await this.buyer.supports(url);
    return JSON.stringify(support);
  }
}

export function createBuyerAgentTools(config: BuyerAgentConfig): X402BuyerAgentTools {
  return new X402BuyerAgentTools(new BuyerBatchAgent(config));
}
