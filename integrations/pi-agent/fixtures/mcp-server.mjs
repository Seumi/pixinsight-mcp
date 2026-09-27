import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "pi-pixinsight-test", version: "0.0.0" });
server.tool("echo", { message: z.string() }, async ({ message }) => ({ content: [{ type: "text", text: message }] }));
server.tool("fail", {}, async () => ({ isError: true, content: [{ type: "text", text: "fixture failure" }] }));
server.tool("wait", {}, async () => {
  await new Promise(resolve => setTimeout(resolve, 5000));
  return { content: [{ type: "text", text: "finished" }] };
});
await server.connect(new StdioServerTransport());
