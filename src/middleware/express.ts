import type { Express, Request, Response } from "express";
import { SellerBatchAgent } from "../core/seller.js";
import type { RoutePaymentConfig, SellerPaymentInfo } from "../core/types.js";

export type PaidRequest = Request & { payment?: SellerPaymentInfo };

export function mountPaidJsonRoute<T>(
  app: Express,
  method: "get" | "post" | "put" | "patch" | "delete",
  path: string,
  seller: SellerBatchAgent,
  route: RoutePaymentConfig,
  handler: (payment: SellerPaymentInfo, req: PaidRequest) => Promise<T> | T,
): void {
  const stack = seller.paidJsonRoute(route, handler as any);
  (app as any)[method](path, ...stack);
}

export function sendNoSecretHealth(_req: Request, res: Response): void {
  res.json({ ok: true, service: "x402-arc-sdk", secrets: "redacted" });
}
