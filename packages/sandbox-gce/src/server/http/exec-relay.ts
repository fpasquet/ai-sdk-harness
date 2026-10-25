import type { IncomingMessage, ServerResponse } from 'node:http';

import type { Sandboxes } from '../sandboxes/sandboxes.js';

import { readCommandLine } from '../../common/command-line.js';
import { HttpError } from '../../common/http-error.js';

/** The agent's error, as its JSON says it. */
async function errorOf(answer: IncomingMessage): Promise<HttpError> {
  const chunks: Buffer[] = [];
  for await (const chunk of answer as AsyncIterable<Buffer>) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString();
  let message = text;
  try {
    message = (JSON.parse(text) as { error?: string }).error ?? text;
  } catch {
    // Not the agent's JSON.
  }
  return new HttpError(answer.statusCode ?? 502, message);
}

/**
 * `POST /v1/sandboxes/:name/exec`, passed on to the agent of the sandbox's machine once the proxy
 * found no credential of the sandbox in the command. The body is a line of JSON,
 * `{ command, workingDirectory?, env? }`, then the command's standard input; the answer streams the
 * agent's frames, the process named in `X-Process-Id`. The process outlives the request: Cloud Run
 * cuts any request after its timeout, and the caller then waits for its exit by id.
 */
export async function execRelay(
  sandboxes: Sandboxes,
  name: string,
  { request, response }: { request: IncomingMessage; response: ServerResponse },
): Promise<void> {
  const { command, line, rest } = await readCommandLine(request);
  const agent = await sandboxes.agent(name);
  await sandboxes.assertNoSecret(name, [
    command.command,
    command.workingDirectory ?? '',
    ...Object.values(command.env ?? {}),
  ]);
  const call = agent.exec();
  call.request.write(Buffer.concat([line, Buffer.from('\n'), rest]));
  request.pipe(call.request);
  request.resume();
  const answer = await call.response;
  if (answer.statusCode !== 200) throw await errorOf(answer);
  response.writeHead(200, {
    'content-type': 'application/octet-stream',
    'x-process-id': answer.headers['x-process-id'] ?? '',
  });
  // At once: the caller waits for the process's id, and a quiet command writes nothing for long.
  response.flushHeaders();
  answer.pipe(response);
  // The caller gone, the agent's stream is let go: the process runs on, its exit kept by id.
  response.once('close', () => answer.destroy());
  await new Promise<void>((resolve) => answer.once('close', resolve));
}
