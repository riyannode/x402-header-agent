import test from "node:test";
import assert from "node:assert/strict";
import { DualRoleAgent } from "../src/agents/dual-role-agent.js";
import { BuyerBatchAgent } from "../src/core/buyer.js";
import { SellerBatchAgent } from "../src/core/seller.js";
import { ConfigurationError } from "../src/core/errors.js";
import type { SellerPaymentInfo, PaymentReceipt } from "../src/core/types.js";

const buyerConfig = {
  dcw: {
    apiKey: "test-api-key",
    entitySecret: "test-entity-secret",
    walletId: "test-wallet-id",
    walletAddress: "0x0000000000000000000000000000000000000002",
    blockchain: "ARC-TESTNET",
  },
  policy: {
    hostAllowlist: ["example.com"],
    allowLocalhost: false,
  },
};

const sellerConfig = {
  sellerAddress: "0x0000000000000000000000000000000000000001",
};

test("constructor accepts different seller and buyer wallet addresses", () => {
  const agent = new DualRoleAgent({ seller: sellerConfig, buyer: buyerConfig });
  assert.ok(agent instanceof DualRoleAgent);
});

test("constructor rejects same seller and buyer wallet address with ConfigurationError", () => {
  assert.throws(
    () =>
      new DualRoleAgent({
        seller: { sellerAddress: "0x00000000000000000000000000000000000000AA" },
        buyer: {
          ...buyerConfig,
          dcw: {
            ...buyerConfig.dcw,
            walletAddress: "0x00000000000000000000000000000000000000AA",
          },
        },
      }),
    (err: unknown) => err instanceof ConfigurationError,
  );
});

test("constructor rejects same address case-insensitively", () => {
  assert.throws(
    () =>
      new DualRoleAgent({
        seller: { sellerAddress: "0x00000000000000000000000000000000000000aa" },
        buyer: {
          ...buyerConfig,
          dcw: {
            ...buyerConfig.dcw,
            walletAddress: "0x00000000000000000000000000000000000000AA",
          },
        },
      }),
    (err: unknown) => err instanceof ConfigurationError,
  );
});

test(".seller is instance of SellerBatchAgent", () => {
  const agent = new DualRoleAgent({ seller: sellerConfig, buyer: buyerConfig });
  assert.ok(agent.seller instanceof SellerBatchAgent);
});

test(".buyer is instance of BuyerBatchAgent", () => {
  const agent = new DualRoleAgent({ seller: sellerConfig, buyer: buyerConfig });
  assert.ok(agent.buyer instanceof BuyerBatchAgent);
});

test("paidJsonRouteWithSpend() delegates to seller.paidJsonRoute()", () => {
  const agent = new DualRoleAgent({ seller: sellerConfig, buyer: buyerConfig });

  let capturedRoute: unknown;
  let capturedHandler: unknown;
  const fakeReturn = ["middleware", "controller"];

  agent.seller.paidJsonRoute = ((route: unknown, handler: unknown) => {
    capturedRoute = route;
    capturedHandler = handler;
    return fakeReturn;
  }) as typeof agent.seller.paidJsonRoute;

  const myHandler = async (
    _spend: unknown,
    _req: unknown,
    _payment: unknown,
  ) => "result";
  const result = agent.paidJsonRouteWithSpend(
    { priceUsdc: "0.01" },
    myHandler,
  );

  assert.deepEqual(result, fakeReturn);
  assert.deepEqual(capturedRoute, { priceUsdc: "0.01" });
  assert.ok(typeof capturedHandler === "function");
});

test("handler receives spend function, request, and seller payment info", async () => {
  const agent = new DualRoleAgent({ seller: sellerConfig, buyer: buyerConfig });

  let handlerSpend: unknown;
  let handlerReq: unknown;
  let handlerPayment: unknown;

  // Capture the inner handler passed to seller.paidJsonRoute
  let innerHandler: ((payment: SellerPaymentInfo, req: unknown) => Promise<unknown>) | undefined;
  agent.seller.paidJsonRoute = ((_route: unknown, handler: unknown) => {
    innerHandler = handler as typeof innerHandler;
    return [];
  }) as typeof agent.seller.paidJsonRoute;

  agent.paidJsonRouteWithSpend(
    { priceUsdc: "0.001" },
    (spend, req, payment) => {
      handlerSpend = spend;
      handlerReq = req;
      handlerPayment = payment;
      return "ok";
    },
  );

  const fakeReq = { body: { query: "test" } };
  const fakePayment: SellerPaymentInfo = {
    verified: true,
    payer: "0xC0FFEE",
    amount: "0.001",
    network: "eip155:5042002",
  };

  const result = await innerHandler!(fakePayment, fakeReq);

  assert.equal(result, "ok");
  assert.equal(typeof handlerSpend, "function");
  assert.equal(handlerReq, fakeReq);
  assert.equal(handlerPayment, fakePayment);
});

test("calling spend(input) delegates to buyer.payResource(input)", async () => {
  const agent = new DualRoleAgent({ seller: sellerConfig, buyer: buyerConfig });

  let innerHandler: ((payment: SellerPaymentInfo, req: unknown) => Promise<unknown>) | undefined;
  agent.seller.paidJsonRoute = ((_route: unknown, handler: unknown) => {
    innerHandler = handler as typeof innerHandler;
    return [];
  }) as typeof agent.seller.paidJsonRoute;

  let capturedInput: unknown;
  const fakeReceipt: PaymentReceipt = {
    id: "receipt-1",
    status: "success",
    url: "https://example.com/data",
    host: "example.com",
    amountUsdc: "0.001",
    createdAt: new Date().toISOString(),
  };
  agent.buyer.payResource = async (input: unknown) => {
    capturedInput = input;
    return fakeReceipt;
  };

  let spendResult: unknown;
  agent.paidJsonRouteWithSpend(
    { priceUsdc: "0.001" },
    async (spend) => {
      spendResult = await spend({
        url: "https://example.com/data",
        label: "test-fetch",
      });
      return "ok";
    },
  );

  const fakePayment: SellerPaymentInfo = {
    verified: true,
    payer: "0xC0FFEE",
    amount: "0.001",
    network: "eip155:5042002",
  };
  await innerHandler!(fakePayment, {});

  assert.deepEqual(capturedInput, {
    url: "https://example.com/data",
    label: "test-fetch",
  });
  assert.deepEqual(spendResult, fakeReceipt);
});

test("no raw private key field or path is introduced", () => {
  const agent = new DualRoleAgent({ seller: sellerConfig, buyer: buyerConfig });
  const ownKeys = Object.getOwnPropertyNames(agent);
  for (const key of ownKeys) {
    assert.ok(
      !key.toLowerCase().includes("private"),
      `DualRoleAgent has a field containing 'private': ${key}`,
    );
    assert.ok(
      !key.toLowerCase().includes("secret"),
      `DualRoleAgent has a field containing 'secret': ${key}`,
    );
  }
});

test("config is accessible and holds both buyer and seller configs", () => {
  const agent = new DualRoleAgent({ seller: sellerConfig, buyer: buyerConfig });
  assert.equal(agent.config.seller.sellerAddress, sellerConfig.sellerAddress);
  assert.equal(
    agent.config.buyer.dcw.walletAddress,
    buyerConfig.dcw.walletAddress,
  );
});
