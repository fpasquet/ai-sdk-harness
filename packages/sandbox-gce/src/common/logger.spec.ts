import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLogger } from './logger.js';

afterEach(() => vi.restoreAllMocks());

describe('the service logger', () => {
  it('writes JSON lines with their severity, for Cloud Logging', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    createLogger({ json: true }).info('started');
    createLogger({ json: true }).error('failed');

    expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toMatchObject({
      severity: 'INFO',
      message: 'started',
    });
    expect(JSON.parse(String(stderr.mock.calls[0]?.[0]))).toMatchObject({
      severity: 'ERROR',
      message: 'failed',
    });
  });

  it('writes the events of a sandbox as structured JSON lines, their message alone as plain ones', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const event = {
      event: 'create',
      sandbox: 'box',
      message: 'box created',
      fromPool: true,
    } as const;

    createLogger({ json: true }).event(event);
    createLogger({ json: false }).event(event);

    expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toEqual({
      severity: 'INFO',
      message: 'box created',
      event: 'create',
      sandbox: 'box',
      at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) as unknown,
      time: expect.any(String) as unknown,
      fromPool: true,
    });
    expect(String(stdout.mock.calls[1]?.[0])).toMatch(/^\S+ INFO box created\n$/);
  });

  it('writes plain lines off Cloud Run', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    createLogger({ json: false }).info('started');

    expect(String(stdout.mock.calls[0]?.[0])).toMatch(/^\S+ INFO started\n$/);
  });
});
