import { BatchFacilitatorClient, createGatewayMiddleware } from "@circle-fin/x402-batching/server";
import type { NextFunction, Request, Response } from "express";
import type { RoutePaymentConfig, SellerAgentConfig, SellerPaymentInfo } from "./types.js";
import { GatewayPaymentError } from "./errors.js";
import { normalizeUsdc } from "../utils/money.js";

function priceString(price: string | number): string {
  const normalized = normalizeUsdc(price);
  return `$${normalized}`;
}

function redactGatewayError(error: unknown): string {
  if (error instanceof Error) {
    return error.message
      .replace(/0x[a-fA-F0-9]{64,}/g, "0x[redacted]")
      .replace(/Payment-Signature:\s*[^\n]+/gi, "Payment-Signature: [redacted]")
      .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]");
  }
  return String(error);
}

export class SellerBatchAgent {
  readonly sellerAddress: string;
  readonly facilitatorUrl: string;
  readonly networks?: string[];
  readonly description?: string;
  readonly gatewayMiddleware: any;
  readonly facilitator: any;

  constructor(config: SellerAgentConfig) {
    this.sellerAddress = config.sellerAddress;
    this.facilitatorUrl = config.facilitatorUrl ?? "https://gateway-api-testnet.circle.com";
    this.networks = config.networks;
    this.description = config.description;
    this.gatewayMiddleware = createGatewayMiddleware({
      sellerAddress: config.sellerAddress,
      facilitatorUrl: this.facilitatorUrl,
      ...(config.networks ? { networks: config.networks } : {}),
      ...(config.description ? { description: config.description } : {}),
    } as any);
    this.facilitator = new BatchFacilitatorClient({ url: this.facilitatorUrl } as any);
  }

  requirePayment(route: RoutePaymentConfig): any {
    return this.gatewayMiddleware.require(priceString(route.priceUsdc));
  }

  paidJsonRoute<T>(route: RoutePaymentConfig, handler: (payment: SellerPaymentInfo, req: Request) => Promise<T> | T): any[] {
    const middleware = this.requirePayment(route);
    const controller = async (req: Request & { payment?: SellerPaymentInfo }, res: Response, next: NextFunction) => {
      try {
        if (!req.payment?.verified) throw new GatewayPaymentError("Payment was not verified by Circle Gateway middleware");
        const data = await handler(req.payment, req);
        res.json({ ok: true, payment: req.payment, data });
      } catch (error) {
        next(error);
      }
    };
    return [middleware, controller];
  }

  async settlePaymentPayload(payload: unknown, requirements: unknown): Promise<unknown> {
    try {
      return await this.facilitator.settle(payload, requirements);
    } catch (error) {
      throw new GatewayPaymentError(`Gateway settlement failed: ${redactGatewayError(error)}`, error);
    }
  }
}

export function createSellerBatchAgent(config: SellerAgentConfig): SellerBatchAgent {
  return new SellerBatchAgent(config);
}
