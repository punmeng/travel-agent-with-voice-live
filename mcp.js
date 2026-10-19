import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createSession, callTool, toolSchemas, selectOffer, setTrip } from './lib/core.js';
import { ZodError } from 'zod';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

export function createMcpServer() {
  const server = new McpServer({ name: 'meihao-airlines-mock', version: '0.1.0' });
  const session = createSession();
  for (const [name, schema] of Object.entries(toolSchemas)) {
    server.registerTool(name, {
      description: name === 'resolve_city_airports'
        ? 'Deterministic geographic city/airport lookup using vetted exact normalized aliases. query and nullable countryCode required. Returns matched/ambiguous/not_found, candidate airports and provenance. City membership NEVER establishes DEMO-operated route eligibility; schedules and fares are separate synthetic tools. No fuzzy guessing.'
        : `MOCK SYNTHETIC DEMO: ${name}. Marketing and operating carrier DEMO, no AE/partners/codeshares. Hypothetical routes NOT verified DEMO operations. Synthetic TWD adult fares, never live inventory or payment. Session-scoped offers, 60 tool units maximum.`,
      inputSchema: schema
    }, async args => {
      try {
        // MCP has no transaction tool. Its repricing selects only an offer it already owns.
        if (name === 'search_flights') setTrip(session, { ...args, budget: null, lowWalking: false });
        if (name === 'reprice_offer') selectOffer(session, args.offerId);
        const output = await callTool(session, name === 'reprice_offer' ? 'price' : 'flight', name, args);
        return { content: [{ type: 'text', text: JSON.stringify(output) }] };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({
          mock: true, correlationId: randomUUID(), error: error instanceof ZodError ? 'INVALID_ARGUMENT' : error.code ?? 'TOOL_ERROR',
          message: error instanceof ZodError ? error.issues.map(i => i.message).join('; ') : error.message
        }) }] };
      }
    });
  }
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await createMcpServer().connect(new StdioServerTransport());
}
