import type { HarnessV1RequestTransformation } from '@ai-sdk/harness';
import type { IncomingMessage } from 'node:http';

import { HttpError } from './http-error.js';

/** A JSON body larger than this is refused: a command's input goes after it, unparsed. */
const MAX_JSON_BYTES = 1 << 20;

type Json = Record<string, unknown>;

const invalid = (message: string): HttpError => new HttpError(400, message);

/** The request's JSON body, an object; `{}` when it has none. */
export async function readJson(request: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) throw new HttpError(413, 'The request body is too large.');
    chunks.push(chunk);
  }
  return parseObject(Buffer.concat(chunks).toString() || '{}');
}

/** `text` as a JSON object. */
export function parseObject(text: string): Json {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw invalid('The request body is not JSON.');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid('The request body is not a JSON object.');
  }
  return value as Json;
}

export function optionalString(body: Json, field: string): string | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw invalid(`\`${field}\` must be a string.`);
  return value;
}

export function requiredString(body: Json, field: string): string {
  const value = optionalString(body, field);
  if (value === undefined) throw invalid(`\`${field}\` is required.`);
  return value;
}

export function stringList(body: Json, field: string): string[] | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw invalid(`\`${field}\` must be an array of strings.`);
  }
  return value;
}

export function stringRecord(body: Json, field: string): Record<string, string> | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  const valid =
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === 'string');
  if (!valid) throw invalid(`\`${field}\` must be an object of strings.`);
  return value as Record<string, string>;
}

/** The request transformations of the body: their host and the headers they set are checked. */
export function transformationList(body: Json): HarnessV1RequestTransformation[] {
  const value = body['transformations'];
  if (!Array.isArray(value)) throw invalid('`transformations` must be an array.');
  return value.map((item: unknown, index) => {
    const { match, transform } = (item ?? {}) as { match?: Json; transform?: Json };
    if (
      typeof match?.['host'] !== 'string' ||
      stringRecord(transform ?? {}, 'headers') === undefined
    ) {
      throw invalid(
        `\`transformations[${index}]\` needs a \`match.host\` and \`transform.headers\`.`,
      );
    }
    return item as HarnessV1RequestTransformation;
  });
}
