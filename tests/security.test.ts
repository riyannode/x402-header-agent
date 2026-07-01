import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { BuyerBatchAgent } from "../src/core/buyer.js";
import { PaymentPolicy } from "../src/core/policy.js";
import { InMemorySpendLedger } from "../src/core/ledger.js";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    const st = statSync(full);
    return st.isDirectory() ? walk(full) : [full];
  });
}

test("source has no raw-key buyer implementation path", () => {
  const forbidden = [new RegExp("privateKey" + "ToAccount"), new RegExp("GatewayClient" + "\\s*\\("), new RegExp(["BUYER", "PRIVATE", "KEY"].join("_")), new RegExp("seller" + "PrivateKey")];
  for (const file of walk("src")) {
    const text = readFileSync(file, "utf8");
    for (const pattern of forbidden) {
      assert.equal(pattern.test(text), false, `${file} contains forbidden pattern ${pattern}`);
    }
  }
});

test("buyer preflight treats maxUsdcOverride as cap, not payment amount", async () => {
  const buyer = Object.create(BuyerBatchAgent.prototype) as BuyerBatchAgent & any;
  buyer.policy = new PaymentPolicy({ dailyBudgetUsdc: "10", maxSinglePaymentUsdc: "10" });
  buyer.address = "0x0000000000000000000000000000000000000001";
  buyer.ledger = new InMemorySpendLedger();
  buyer.supports = async () => ({ supported: true, url: "https://seller.example/data", host: "seller.example", amountUsdc: "0.2" });
  buyer.ensureGatewayBalance = async () => ({ walletUsdc: "1", gatewayAvailableUsdc: "1" });

  await assert.rejects(
    () => buyer.preflight({ url: "https://seller.example/data", maxUsdcOverride: "0.1" }),
    /exceeds caller cap/,
  );
});
