import test from "node:test";
import assert from "node:assert/strict";
import { PaymentPolicy } from "../src/core/policy.js";
import { InMemorySpendLedger } from "../src/core/ledger.js";

const wallet = "0x0000000000000000000000000000000000000001";

test("policy blocks http remote url", () => {
  const policy = new PaymentPolicy();
  assert.throws(() => policy.validateUrl("http://example.com/data"), /HTTPS/);
});

test("policy allows localhost only when explicitly enabled", () => {
  const strict = new PaymentPolicy({ allowLocalhost: false });
  assert.throws(() => strict.validateUrl("http://localhost:3000/data"), /HTTPS|Private/);
  const local = new PaymentPolicy({ allowLocalhost: true, hostAllowlist: ["*"] });
  assert.equal(local.validateUrl("http://localhost:3000/data").hostname, "localhost");
});

test("policy blocks host outside allowlist", () => {
  const policy = new PaymentPolicy({ hostAllowlist: ["api.paylabs.local"] });
  assert.throws(() => policy.validateUrl("https://evil.example/data"), /ALLOWLIST|allowlist/i);
});

test("policy enforces daily budget", async () => {
  const ledger = new InMemorySpendLedger();
  await ledger.recordPayment({
    id: "p1",
    walletAddress: wallet,
    url: "https://api.example.com/a",
    host: "api.example.com",
    amountUsdc: "0.9",
    status: "success",
    createdAt: new Date().toISOString(),
  });
  const policy = new PaymentPolicy({ dailyBudgetUsdc: "1" });
  await assert.rejects(() => policy.validateDailyBudget({ walletAddress: wallet, ledger, plannedAmountsUsdc: ["0.2"] }), /Daily budget/);
});

test("default policy rejects public HTTPS host when allowlist is empty", () => {
  const policy = new PaymentPolicy();
  assert.throws(() => policy.validateUrl("https://seller.example.com"), /allowlist/i);
});

test("explicit allowlist permits listed host", () => {
  const policy = new PaymentPolicy({ hostAllowlist: ["seller.example.com"] });
  const url = policy.validateUrl("https://seller.example.com");
  assert.equal(url.hostname, "seller.example.com");
});

test("explicit wildcard allowlist permits public HTTPS hosts", () => {
  const policy = new PaymentPolicy({ hostAllowlist: ["*"] });
  const url = policy.validateUrl("https://seller.example.com");
  assert.equal(url.hostname, "seller.example.com");
});
