/**
 * Example MCP Tool: echo
 *
 * Returns the input message unchanged. Useful as a minimal working example
 * that exercises the full initialize → tools/list → tools/call flow.
 */

import { z } from "zod";
import { registerMcpTool } from "@/mcp/registry.ts";

registerMcpTool({
  name: "echo",
  description: "Echo the provided message back to the caller",
  inputSchema: {
    message: z.string().min(1).describe("The message to echo"),
  },
  handler: async (args) => {
    const message = String(args.message ?? "");
    return {
      content: [{ type: "text", text: message }],
    };
  },
});
