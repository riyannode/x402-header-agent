import test from "node:test";
import assert from "node:assert/strict";
import { toCircleTypedDataJson } from "../src/core/dcw-wallet.js";

test("toCircleTypedDataJson injects EIP712Domain when missing", () => {
  const params = {
    domain: {
      name: "GatewayWalletBatched",
      version: "1",
      chainId: 5042002,
      verifyingContract: "0x0077777d7eba4688bdef3e311b846f25870a19b9" as any,
    },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: {
      from: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      to: "0x0000000000000000000000000000000000000001",
      value: "1000",
      validAfter: "0",
      validBefore: "9999999999",
      nonce: "0x" + "ab".repeat(32),
    },
  };

  const json = toCircleTypedDataJson(params as any);
  const parsed = JSON.parse(json);

  assert.ok(parsed.types.EIP712Domain, "EIP712Domain should be present");
  assert.equal(parsed.types.EIP712Domain.length, 4, "EIP712Domain should have 4 fields");
  assert.equal(parsed.types.EIP712Domain[0].name, "name");
  assert.equal(parsed.types.EIP712Domain[0].type, "string");
  assert.equal(parsed.types.EIP712Domain[1].name, "version");
  assert.equal(parsed.types.EIP712Domain[1].type, "string");
  assert.equal(parsed.types.EIP712Domain[2].name, "chainId");
  assert.equal(parsed.types.EIP712Domain[2].type, "uint256");
  assert.equal(parsed.types.EIP712Domain[3].name, "verifyingContract");
  assert.equal(parsed.types.EIP712Domain[3].type, "address");

  assert.equal(parsed.primaryType, "TransferWithAuthorization");
  assert.equal(parsed.domain.chainId, 5042002);
  assert.equal(parsed.domain.name, "GatewayWalletBatched");
  assert.equal(parsed.types.TransferWithAuthorization.length, 6);
  assert.equal(parsed.message.from, "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.equal(parsed.message.value, "1000");
});

test("toCircleTypedDataJson preserves existing EIP712Domain", () => {
  const params = {
    domain: {
      name: "Test",
      version: "1",
      chainId: 1,
      verifyingContract: "0x" + "11".repeat(20) as any,
    },
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      CustomType: [{ name: "field", type: "uint256" }],
    },
    primaryType: "CustomType",
    message: { field: "42" },
  };

  const json = toCircleTypedDataJson(params as any);
  const parsed = JSON.parse(json);

  assert.equal(parsed.types.EIP712Domain.length, 4, "existing EIP712Domain should be preserved");
  assert.ok(parsed.types.CustomType, "CustomType should be preserved");
  assert.equal(parsed.types.CustomType.length, 1);
});

test("toCircleTypedDataJson converts bigint to decimal string", () => {
  const params = {
    domain: {
      name: "Test",
      version: "1",
      chainId: 5042002,
      verifyingContract: "0x" + "11".repeat(20) as any,
    },
    types: {
      TransferWithAuthorization: [{ name: "value", type: "uint256" }],
    },
    primaryType: "TransferWithAuthorization",
    message: { value: BigInt("1000000000000000000") },
  };

  const json = toCircleTypedDataJson(params as any);
  const parsed = JSON.parse(json);

  assert.equal(typeof parsed.message.value, "string");
  assert.equal(parsed.message.value, "1000000000000000000");
});
