import type { BuyerBatchAgent } from "../core/buyer.js";
import type { SellerBatchAgent } from "../core/seller.js";
import type { BatchPayInput, PayResourceInput, RoutePaymentConfig } from "../core/types.js";

export function buyerPlainFunctions(buyer: BuyerBatchAgent) {
  return {
    x402_pay_resource: (input: PayResourceInput) => buyer.payResource(input),
    x402_pay_batch: (input: BatchPayInput) => buyer.payBatch(input),
    x402_gateway_balance: () => buyer.getBalances(),
    x402_gateway_deposit: (amountUsdc: string) => buyer.createGatewayDeposit(amountUsdc),
    x402_supports: (url: string) => buyer.supports(url),
  };
}

export function sellerPlainFunctions(_seller: SellerBatchAgent) {
  return {
    x402_seller_route_plan: (route: RoutePaymentConfig) => ({
      route,
      middleware: "seller.requirePayment(route)",
      settlement: "Circle Gateway batched settle",
    }),
  };
}
