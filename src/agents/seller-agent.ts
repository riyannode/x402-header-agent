import type { RoutePaymentConfig, SellerAgentConfig } from "../core/types.js";
import { SellerBatchAgent } from "../core/seller.js";

export interface SellerAgentToolset {
  x402_seller_route_plan(route: RoutePaymentConfig): Promise<string>;
}

export class X402SellerAgentTools implements SellerAgentToolset {
  constructor(readonly seller: SellerBatchAgent) {}

  async x402_seller_route_plan(route: RoutePaymentConfig): Promise<string> {
    return JSON.stringify({
      middleware: "createGatewayMiddleware().require(price)",
      price: route.priceUsdc,
      priceHeader: `$${route.priceUsdc}`,
      description: route.description,
      settlement: "Circle Gateway settle() via @circle-fin/x402-batching/server",
    });
  }
}

export function createSellerAgentTools(config: SellerAgentConfig): X402SellerAgentTools {
  return new X402SellerAgentTools(new SellerBatchAgent(config));
}
