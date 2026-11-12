import type { IncomingMessage } from 'node:http';

import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';

import {
  optionalString,
  parseObject,
  readJson,
  requiredString,
  stringList,
  stringRecord,
  transformationList,
} from './http-body.js';

const requestOf = (...chunks: Buffer[]): IncomingMessage =>
  Readable.from(chunks) as unknown as IncomingMessage;

describe('the JSON bodies of the servers', () => {
  it('reads an object, `{}` for no body, and refuses one too large', async () => {
    await expect(readJson(requestOf(Buffer.from('{"a":1}')))).resolves.toEqual({ a: 1 });
    await expect(readJson(requestOf())).resolves.toEqual({});
    await expect(readJson(requestOf(Buffer.alloc((1 << 20) + 1)))).rejects.toMatchObject({
      status: 413,
    });
  });

  it('refuses what is not a JSON object', () => {
    expect(() => parseObject('{')).toThrow('not JSON');
    expect(() => parseObject('[]')).toThrow('not a JSON object');
    expect(() => parseObject('null')).toThrow('not a JSON object');
    expect(() => parseObject('1')).toThrow('not a JSON object');
  });

  it('checks the type of each field', () => {
    expect(optionalString({}, 'a')).toBeUndefined();
    expect(() => optionalString({ a: 1 }, 'a')).toThrow('`a` must be a string.');
    expect(() => requiredString({}, 'a')).toThrow('`a` is required.');
    expect(stringList({ a: ['x'] }, 'a')).toEqual(['x']);
    expect(stringList({}, 'a')).toBeUndefined();
    expect(() => stringList({ a: 'x' }, 'a')).toThrow('array of strings');
    expect(() => stringList({ a: [1] }, 'a')).toThrow('array of strings');
    expect(stringRecord({}, 'a')).toBeUndefined();
    expect(() => stringRecord({ a: null }, 'a')).toThrow('object of strings');
    expect(() => stringRecord({ a: ['x'] }, 'a')).toThrow('object of strings');
    expect(() => stringRecord({ a: { b: 1 } }, 'a')).toThrow('object of strings');
  });

  it('checks the host and the headers of each transformation', () => {
    const valid = { match: { host: 'api.example.com' }, transform: { headers: { a: 'b' } } };

    expect(transformationList({ transformations: [valid] })).toEqual([valid]);
    expect(() => transformationList({})).toThrow('`transformations` must be an array.');
    expect(() => transformationList({ transformations: [null] })).toThrow(
      '`transformations[0]` needs a `match.host` and `transform.headers`.',
    );
    expect(() => transformationList({ transformations: [{ match: { host: 'h' } }] })).toThrow(
      'needs a `match.host`',
    );
  });
});
