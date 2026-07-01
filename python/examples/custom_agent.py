from x402_arc_sdk import X402ArcClient

client = X402ArcClient.from_env()
tools = client.custom_tools()
print(sorted(tools.keys()))
