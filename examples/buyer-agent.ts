import { BuyerBatchAgent, buyerConfigFromEnv } from "../src/index.js";

const url = process.argv[2];
if (!url) throw new Error("Usage: npm run example:buyer -- https://seller.example.com/premium-data");

const buyer = new BuyerBatchAgent(buyerConfigFromEnv());

const support = await buyer.supports(url);
console.log("support", support);

if (!support.supported) process.exit(1);

const receipt = await buyer.payResource({ url, label: "single-example" });
console.log(JSON.stringify(receipt, null, 2));
