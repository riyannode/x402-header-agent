import { BuyerBatchAgent, buyerConfigFromEnv } from "../src/index.js";

const urls = process.argv.slice(2);
if (!urls.length) throw new Error("Usage: npm run example:batch -- https://seller-a/path https://seller-b/path");

const buyer = new BuyerBatchAgent(buyerConfigFromEnv());
const result = await buyer.payBatch({
  requests: urls.map((url, i) => ({ url, label: `resource-${i + 1}` })),
  concurrency: 4,
});

console.log(JSON.stringify(result, null, 2));
