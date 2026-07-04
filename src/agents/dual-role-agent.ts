import { BuyerBatchAgent } from "../core/buyer.js";
import { SellerBatchAgent } from "../core/seller.js";
import { ConfigurationError } from "../core/errors.js";
import type {
  BuyerAgentConfig,
  SellerAgentConfig,
  RoutePaymentConfig,
  PayResourceInput,
  PaymentReceipt,
  SellerPaymentInfo,
} from "../core/types.js";

export interface DualRoleAgentConfig {
  seller: SellerAgentConfig;
  buyer: BuyerAgentConfig;
}

export type DualRoleSpend = (input: PayResourceInput) => Promise<PaymentReceipt>;

export class DualRoleAgent {
  readonly seller: SellerBatchAgent;
  readonly buyer: BuyerBatchAgent;

  constructor(readonly config: DualRoleAgentConfig) {
    const sellerAddress = config.seller.sellerAddress.toLowerCase();
    const buyerAddress = config.buyer.dcw.walletAddress.toLowerCase();

    if (sellerAddress === buyerAddress) {
      throw new ConfigurationError(
        "Seller wallet and buyer wallet must differ for dual-role agents",
      );
    }

    this.seller = new SellerBatchAgent(config.seller);
    this.buyer = new BuyerBatchAgent(config.buyer);
  }

  paidJsonRouteWithSpend<T>(
    route: RoutePaymentConfig,
    handler: (
      spend: DualRoleSpend,
      req: unknown,
      payment: SellerPaymentInfo,
    ) => Promise<T> | T,
  ): any[] {
    return this.seller.paidJsonRoute(route, async (payment, req) => {
      const spend: DualRoleSpend = (input) => this.buyer.payResource(input);
      return handler(spend, req, payment);
    });
  }
}
