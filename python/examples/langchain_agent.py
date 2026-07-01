from x402_arc_sdk import X402ArcClient

client = X402ArcClient.from_env()
tools = client.langchain_tools()
print([tool.name for tool in tools])
