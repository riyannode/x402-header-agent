import { BuyerBatchAgent, buyerConfigFromEnv } from "../src/index.js";
import { getLangChainBuyerTools } from "../src/adapters/langchain.js";

const buyer = new BuyerBatchAgent(buyerConfigFromEnv());
const tools = await getLangChainBuyerTools(buyer);
console.log(tools.map((tool: any) => tool.name));
