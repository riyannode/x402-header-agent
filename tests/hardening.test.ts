import test from "node:test";
import assert from "node:assert/strict";
import { BuyerBatchAgent } from "../src/core/buyer.js";
import { PaymentPolicy } from "../src/core/policy.js";
import { InMemorySpendLedger } from "../src/core/ledger.js";
import { getCrewAIStyleBuyerTools } from "../src/adapters/crewai.js";

function stubBuyer(): BuyerBatchAgent & any {
  const buyer = Object.create(BuyerBatchAgent.prototype) as BuyerBatchAgent & any;
  buyer.policy = new PaymentPolicy({ dailyBudgetUsdc: "10", maxSinglePaymentUsdc: "10", maxBatchPaymentUsdc: "10", hostAllowlist: ["*"] });
  buyer.address = "0x0000000000000000000000000000000000000001";
  buyer.ledger = new InMemorySpendLedger();
  buyer.ensureGatewayBalance = async () => ({ walletUsdc: "10", gatewayAvailableUsdc: "10" });
  return buyer;
}

test("supports returns unsupported instead of throwing on invalid URL", async () => {
  const buyer = stubBuyer();
  const result = await buyer.supports("not-a-url");
  assert.equal(result.supported, false);
  assert.match(result.error ?? "", /Invalid URL/);
});

test("payResource returns rejected receipt instead of throwing on invalid URL", async () => {
  const buyer = stubBuyer();
  const receipt = await buyer.payResource({ url: "not-a-url" });
  assert.equal(receipt.status, "rejected");
  assert.match(receipt.error ?? "", /Invalid URL/);
});

test("payBatch is fail-closed even when caller passes failFast false", async () => {
  const buyer = stubBuyer();
  buyer.supports = async (url: string) => url.includes("bad")
    ? ({ supported: false, url, host: "bad.example", error: "unsupported" })
    : ({ supported: true, url, host: "ok.example", amountUsdc: "0.001" });
  let paid = 0;
  buyer.payResource = async () => { paid += 1; return { id: "p", status: "success", url: "https://ok.example", host: "ok.example", amountUsdc: "0.001", createdAt: new Date().toISOString() }; };
  const result = await buyer.payBatch({ failFast: false, requests: [{ url: "https://ok.example" }, { url: "https://bad.example" }] });
  assert.equal(result.status, "rejected");
  assert.equal(paid, 0);
});

test("CrewAI-style adapter exposes payment, batch, balance, deposit, and supports tools", () => {
  const tools = getCrewAIStyleBuyerTools(stubBuyer()).map((tool) => tool.name).sort();
  assert.deepEqual(tools, ["x402_gateway_balance", "x402_gateway_deposit", "x402_pay_batch", "x402_pay_resource", "x402_supports"].sort());
});

import { toCircleTypedDataJson } from "../src/core/dcw-wallet.js";

test("Circle DCW typed-data JSON serialization handles BigInt values", () => {
  const json = toCircleTypedDataJson({
    domain: {
      name: "GatewayWalletBatched",
      version: "1",
      chainId: 5042002,
      verifyingContract: "0x0000000000000000000000000000000000000001",
    },
    types: {
      TransferWithAuthorization: [
        { name: "value", type: "uint256" },
        { name: "validBefore", type: "uint256" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: {
      value: 1000n,
      validBefore: 1234567890n,
      nonce: "0x0000000000000000000000000000000000000000000000000000000000000000",
    },
  });
  const parsed = JSON.parse(json);
  assert.equal(parsed.message.value, "1000");
  assert.equal(parsed.message.validBefore, "1234567890");
});

test("policy blocks direct private IP URLs before fetch", async () => {
  const policy = new PaymentPolicy({ hostAllowlist: ["*"], allowLocalhost: false });
  await assert.rejects(() => policy.validateNetworkTarget("https://127.0.0.1/premium"), /Private\/local|private\/local|resolves/);
  await assert.rejects(() => policy.validateNetworkTarget("https://10.0.0.1/premium"), /Private\/local|private\/local|resolves/);
});

test("payBatch pins preflight amount as the live per-resource cap", async () => {
  const buyer = stubBuyer();
  buyer.supports = async () => ({ supported: true, url: "https://seller.example/data", host: "seller.example", amountUsdc: "0.001" });
  let observedCap = "";
  buyer.payResource = async (input: any) => {
    observedCap = input.maxUsdcOverride;
    return { id: "p", status: "success", url: input.url, host: "seller.example", amountUsdc: "0.001", createdAt: new Date().toISOString() };
  };
  const result = await buyer.payBatch({ requests: [{ url: "https://seller.example/data", maxUsdcOverride: "0.01" }] });
  assert.equal(result.status, "success");
  assert.equal(observedCap, "0.001");
});

import { FileSpendLedger } from "../src/core/ledger.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("InMemorySpendLedger reservePayment counts reserved spend atomically", async () => {
  const ledger = new InMemorySpendLedger();
  const walletAddress = "0x0000000000000000000000000000000000000001";
  const createdAt = new Date().toISOString();
  await ledger.reservePayment({ id: "r1", walletAddress, url: "https://a.example", host: "a.example", amountUsdc: "0.7", status: "reserved", createdAt }, "1", createdAt.slice(0, 10));
  await assert.rejects(
    () => ledger.reservePayment!({ id: "r2", walletAddress, url: "https://b.example", host: "b.example", amountUsdc: "0.4", status: "reserved", createdAt }, "1", createdAt.slice(0, 10)),
    /Daily budget exceeded/,
  );
  await ledger.recordPayment({ id: "r1", walletAddress, url: "https://a.example", host: "a.example", amountUsdc: "0.7", status: "failed", createdAt });
  assert.equal(await ledger.getDailySpend(walletAddress, createdAt.slice(0, 10)), "0");
});

test("FileSpendLedger reservePayment fails closed under concurrent reservations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "x402-ledger-"));
  try {
    const ledger = new FileSpendLedger(join(dir, "ledger.json"));
    const walletAddress = "0x0000000000000000000000000000000000000001";
    const createdAt = new Date().toISOString();
    const attempts = await Promise.allSettled(Array.from({ length: 5 }, (_, index) => ledger.reservePayment!({
      id: `reserve-${index}`,
      walletAddress,
      url: `https://seller-${index}.example`,
      host: `seller-${index}.example`,
      amountUsdc: "0.3",
      status: "reserved",
      createdAt,
    }, "1", createdAt.slice(0, 10))));
    const fulfilled = attempts.filter((result) => result.status === "fulfilled").length;
    assert.equal(fulfilled, 3);
    assert.equal(await ledger.getDailySpend(walletAddress, createdAt.slice(0, 10)), "0.9");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("policy blocks IPv4-mapped private IPv6 literals", () => {
  const policy = new PaymentPolicy({ hostAllowlist: ["*"], allowLocalhost: false });
  assert.throws(() => policy.validateUrl("https://[::ffff:7f00:1]/premium"), /Private\/local|private\/local/);
  assert.throws(() => policy.validateUrl("https://[::ffff:a00:1]/premium"), /Private\/local|private\/local/);
});

test("policy blocks reserved IPv4 ranges that are unsafe for SSRF", () => {
  const policy = new PaymentPolicy({ hostAllowlist: ["*"], allowLocalhost: false });
  assert.throws(() => policy.validateUrl("https://100.64.0.1/premium"), /Private\/local|private\/local/);
  assert.throws(() => policy.validateUrl("https://198.18.0.1/premium"), /Private\/local|private\/local/);
  assert.throws(() => policy.validateUrl("https://224.0.0.1/premium"), /Private\/local|private\/local/);
});

import { dispatchOpenAIToolCall } from "../src/adapters/openai-tools.js";

test("OpenAI dispatcher validates batch tool arguments before buyer execution", async () => {
  const buyer = stubBuyer();
  let paid = 0;
  buyer.payBatch = async () => { paid += 1; throw new Error("should not execute"); };
  await assert.rejects(
    () => dispatchOpenAIToolCall(buyer, "x402_pay_batch", { urls: Array.from({ length: 51 }, (_, index) => `https://seller-${index}.example/data`) }),
    /Array must contain at most 50 element\(s\)/,
  );
  assert.equal(paid, 0);
});

import { baseUnitsToUsdc } from "../src/utils/money.js";

test("USDC base-unit conversion rejects negative seller amounts", () => {
  assert.throws(() => baseUnitsToUsdc("-1"), /negative/i);
  assert.throws(() => baseUnitsToUsdc(-1n), /negative/i);
});

import { CircleDcwWallet } from "../src/core/dcw-wallet.js";

test("Circle DCW deposit rejects approval amount below deposit amount", async () => {
  const wallet = new CircleDcwWallet({
    apiKey: "test",
    entitySecret: "test",
    walletId: "00000000-0000-0000-0000-000000000000",
    walletAddress: "0x0000000000000000000000000000000000000001",
  });
  await assert.rejects(
    () => wallet.createGatewayDepositTransactions({
      amountUsdc: "1",
      approveAmountUsdc: "0.5",
      usdcAddress: "0x0000000000000000000000000000000000000002",
      gatewayWalletAddress: "0x0000000000000000000000000000000000000003",
    }),
    /below deposit amount/,
  );
});

test("Circle DCW deposit idempotency prefix produces stable stage keys", async () => {
  const wallet = new CircleDcwWallet({
    apiKey: "test",
    entitySecret: "test",
    walletId: "00000000-0000-0000-0000-000000000000",
    walletAddress: "0x0000000000000000000000000000000000000001",
  }) as CircleDcwWallet & { executeContract: any };
  const observed: string[] = [];
  wallet.executeContract = async (input: any) => {
    observed.push(input.idempotencyKey);
    return "tx-id";
  };
  await wallet.createGatewayDepositTransactions({
    amountUsdc: "1",
    usdcAddress: "0x0000000000000000000000000000000000000002",
    gatewayWalletAddress: "0x0000000000000000000000000000000000000003",
    idempotencyPrefix: "stable-prefix",
  });
  await wallet.createGatewayDepositTransactions({
    amountUsdc: "1",
    usdcAddress: "0x0000000000000000000000000000000000000002",
    gatewayWalletAddress: "0x0000000000000000000000000000000000000003",
    idempotencyPrefix: "stable-prefix",
  });
  assert.equal(observed.length, 2);
  assert.equal(observed[0], observed[1]);
});

test("BuyerBatchAgent constructor works with Circle DCW SDK runtime export shape", () => {
  const buyer = new BuyerBatchAgent({
    dcw: {
      apiKey: "test",
      entitySecret: "test",
      walletId: "00000000-0000-0000-0000-000000000000",
      walletAddress: "0x0000000000000000000000000000000000000001",
    },
  });
  assert.equal(buyer.address, "0x0000000000000000000000000000000000000001");
});
