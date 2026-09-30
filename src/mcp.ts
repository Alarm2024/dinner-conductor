import { McpServer } from "@modelcontextprotocol/server";

const SERVER_VERSION = "1.0.0";

/** Create the dinner-conductor MCP server. Tools are registered in later steps. */
export function createDinnerConductorServer(): McpServer {
  return new McpServer(
    { name: "dinner-conductor", version: SERVER_VERSION },
    {
      instructions:
        "dinner-conductor plans the timing of a multi-dish home meal so every dish is ready at serve time. Out of scope: allergy, nutrition, diet, and food-safety questions. Check doneness with your recipe and a thermometer. Your recipe's times win over any typical times here. Plans stay in memory and are not written to disk.",
    },
  );
}
