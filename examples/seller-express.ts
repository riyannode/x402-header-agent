import express from "express";
import { SellerBatchAgent, mountPaidJsonRoute, sellerConfigFromEnv, sendNoSecretHealth } from "../src/index.js";

const app = express();
const seller = new SellerBatchAgent(sellerConfigFromEnv());

app.get("/health", sendNoSecretHealth);

mountPaidJsonRoute(
  app,
  "get",
  "/premium-data",
  seller,
  { priceUsdc: process.env.X402_DEFAULT_PRICE_USDC || "0.001", description: "Premium data feed" },
  async (payment) => ({
    message: "paid content",
    paidBy: payment.payer,
    amountBaseUnits: payment.amount,
    network: payment.network,
  }),
);

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`seller listening on :${port}`));
