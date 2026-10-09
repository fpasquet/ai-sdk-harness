// A Model Context Protocol server over stdio, with no dependency, for the tests: one tool,
// `get_secret_word`, that answers with the `SECRET_WORD` of its environment. It runs on the host
// (through an MCP client) and in the sandboxes (started by the runtime), with a bare Node.js.
import { createInterface } from 'node:readline';

const TOOL = {
  name: 'get_secret_word',
  description: 'Gives the secret word of this server. Call it when asked for the secret word.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);

const results = {
  initialize: ({ protocolVersion }) => ({
    protocolVersion: protocolVersion ?? '2025-06-18',
    capabilities: { tools: {} },
    serverInfo: { name: 'secret-word', version: '1.0.0' },
  }),
  ping: () => ({}),
  'tools/list': () => ({ tools: [TOOL] }),
  'tools/call': ({ name }) =>
    name === TOOL.name
      ? { content: [{ type: 'text', text: `The secret word is ${process.env.SECRET_WORD}.` }] }
      : { content: [{ type: 'text', text: `No tool ${name}.` }], isError: true },
};

createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim() === '') return;
  const { id, method, params = {} } = JSON.parse(line);
  if (id === undefined) return; // A notification: nothing to answer.
  const result = results[method];
  send(
    result === undefined
      ? { id, error: { code: -32601, message: `Method not found: ${method}` } }
      : { id, result: result(params) },
  );
});
