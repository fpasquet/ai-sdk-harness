import type { HarnessV1RequestTransformation } from '@ai-sdk/harness';

import { describe, expect, it } from 'vitest';

import type { OutgoingRequest } from './egress-policy.js';

import { appliesTo, isListedHost, isRoutable, transformHeaders } from './egress-policy.js';
import { hostsOf, relayRoute, routeTarget } from './relay-routes.js';

const bearer = (placeholder: string, secret: string): HarnessV1RequestTransformation => ({
  match: {
    host: 'api.anthropic.com',
    headers: [{ key: { exact: 'Authorization' }, value: { exact: `Bearer ${placeholder}` } }],
  },
  transform: { headers: { Authorization: `Bearer ${secret}` } },
});

const request = (authorization: string, path = '/v1/messages'): OutgoingRequest => ({
  host: 'api.anthropic.com',
  method: 'POST',
  path,
  headers: { authorization, 'content-type': 'application/json' },
});

describe('request transformations', () => {
  it('swap the placeholder the sandbox sent for the secret', () => {
    expect(transformHeaders([bearer('ph', 'sk-real')], request('Bearer ph'))).toEqual({
      authorization: 'Bearer sk-real',
      'content-type': 'application/json',
    });
  });

  it('leave a request that does not carry the placeholder as it is', () => {
    const sent = request('Bearer something-else');

    expect(transformHeaders([bearer('ph', 'sk-real')], sent)).toEqual(sent.headers);
  });

  it('only apply to their host, path and method', () => {
    const rule: HarnessV1RequestTransformation = {
      ...bearer('p', 's'),
      match: { ...bearer('p', 's').match, path: { startsWith: '/v1' }, method: ['post'] },
    };

    expect(appliesTo(rule, request('Bearer p'))).toBe(true);
    expect(appliesTo(rule, { ...request('Bearer p'), host: 'example.com' })).toBe(false);
    expect(appliesTo(rule, request('Bearer p', '/v2/messages'))).toBe(false);
    expect(appliesTo(rule, { ...request('Bearer p'), method: 'GET' })).toBe(false);
  });

  it('match a header name whatever its case, values by regex, and the query string', () => {
    const rule: HarnessV1RequestTransformation = {
      match: {
        host: 'API.anthropic.com',
        headers: [{ key: { exact: 'X-API-KEY' }, value: { regex: '^ph_' } }],
        queryString: [{ key: { exact: 'beta' }, value: { startsWith: 'tr' } }],
      },
      transform: { headers: { 'x-api-key': 'real' } },
    };
    const sent = { ...request('', '/v1?beta=true'), headers: { 'x-api-key': ['ph_123'] } };

    expect(transformHeaders([rule], sent)).toEqual({ 'x-api-key': 'real' });
    expect(appliesTo(rule, { ...sent, path: '/v1?beta=false' })).toBe(false);
    expect(appliesTo(rule, { ...sent, headers: { 'x-api-key': undefined } })).toBe(false);
  });
});

describe('allowed hosts', () => {
  const allowed = ['registry.npmjs.org', '*.pythonhosted.org'];

  it('allow the hosts listed, those under a wildcard, and any under *', () => {
    expect(isListedHost(allowed, 'registry.npmjs.org')).toBe(true);
    expect(isListedHost(allowed, 'files.pythonhosted.org')).toBe(true);
    expect(isListedHost(allowed, 'REGISTRY.npmjs.org')).toBe(true);
    expect(isListedHost(['*'], 'anything.example.com')).toBe(true);
  });

  it('refuse anything else', () => {
    expect(isListedHost(allowed, 'github.com')).toBe(false);
    expect(isListedHost(allowed, 'pythonhosted.org')).toBe(false);
    expect(isListedHost(allowed, 'evil-registry.npmjs.org.example.com')).toBe(false);
    expect(isListedHost(allowed, '169.254.169.254')).toBe(false);
  });

  it('let a base URL route out to an allowed host, an upstream, or a brokered host', () => {
    const policy = {
      allowedHosts: ['allowed.example.com'],
      upstreamHosts: ['api.openai.com'],
      transformations: [bearer('p', 's')],
      allowPrivateNetwork: false,
    };

    expect(isRoutable(policy, 'allowed.example.com')).toBe(true);
    expect(isRoutable(policy, 'api.openai.com')).toBe(true);
    expect(isRoutable(policy, 'API.anthropic.com')).toBe(true);
    expect(isRoutable(policy, 'metadata.google.internal')).toBe(false);
  });
});

describe('relay routes', () => {
  const relay = 'http://127.0.0.1:3128';

  it('carry the scheme, host and path of a base URL', () => {
    expect(relayRoute('https://api.openai.com/v1/', relay)).toBe(
      `${relay}/https/api.openai.com/v1`,
    );
    expect(routeTarget('/https/api.openai.com/v1/responses?x=1')?.toString()).toBe(
      'https://api.openai.com/v1/responses?x=1',
    );
    expect(routeTarget('/http/localhost:8080')?.toString()).toBe('http://localhost:8080/');
  });

  it('leave alone what is not an HTTP URL, or already a route', () => {
    expect(relayRoute('not a url', relay)).toBeUndefined();
    expect(relayRoute('ftp://files.example.com', relay)).toBeUndefined();
    expect(relayRoute(`${relay}/https/api.openai.com`, relay)).toBeUndefined();
    expect(routeTarget('/v1/messages')).toBeUndefined();
  });

  it('name the hosts of the base URLs, skipping what is no URL', () => {
    expect(hostsOf({ A: 'https://api.anthropic.com', B: 'nonsense' })).toEqual([
      'api.anthropic.com',
    ]);
  });
});
