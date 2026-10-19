import { writeFileSync, mkdirSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../mcp.js';
import { entitlements } from '../lib/core.js';

const server = createMcpServer(), client = new Client({ name: 'tool-schema-export', version: '1' });
const [ct, st] = InMemoryTransport.createLinkedPair();
try {
  await Promise.all([server.connect(st), client.connect(ct)]);
  const { tools } = await client.listTools();
  const manifest = {
    mock: true, generatedFrom: 'lib/core.js toolSchemas via MCP tools/list',
    roles: Object.fromEntries(Object.entries(entitlements).map(([role, names]) => [
      role, tools.filter(t => names.includes(t.name)).map(t => {
        const { $schema, ...parameters } = t.inputSchema;
        // Foundry strict functions reject refs into sibling properties.
        if (t.name === 'search_flights' && parameters.properties.destination.$ref === '#/properties/origin') {
          parameters.properties.destination = structuredClone(parameters.properties.origin);
        }
        return {
          type: 'function', name: t.name, description: t.description,
          parameters: { ...parameters, required: parameters.required ?? [] }, strict: true
        };
      })
    ]))
  };
  mkdirSync(new URL('../data/generated/', import.meta.url), { recursive: true });
  writeFileSync(new URL('../data/generated/foundry-tools.json', import.meta.url), JSON.stringify(manifest, null, 2) + '\n');
  console.log('Exported role-scoped Foundry function definitions; no cloud calls.');
} finally { await client.close(); await server.close(); }
