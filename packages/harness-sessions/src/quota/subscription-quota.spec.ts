import { describe, expect, it } from 'vitest';

import { subscriptionQuota } from './subscription-quota.js';

const inFiveHours = new Date('2026-11-18T15:00:00Z');
const nextWeek = new Date('2026-11-23T09:00:00Z');
const seconds = (date: Date) => date.getTime() / 1000;

describe('subscriptionQuota', () => {
  it('reads every window of a rate_limit_event of the Claude Code CLI', () => {
    expect(
      subscriptionQuota({
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'allowed',
          unifiedWindows: {
            five_hour: { utilization: 0.36, resetsAt: seconds(inFiveHours) },
            seven_day: { utilization: 0.14, resetsAt: seconds(nextWeek) },
          },
        },
      }),
    ).toEqual({
      status: 'allowed',
      windows: {
        five_hour: { utilization: 0.36, percent: 36, resetsAt: inFiveHours },
        seven_day: { utilization: 0.14, percent: 14, resetsAt: nextWeek },
      },
    });
  });

  it('reads the one window of the Claude Agent SDK, in its event or on its own', () => {
    const info = {
      status: 'allowed_warning',
      rateLimitType: 'seven_day_opus',
      utilization: 0.8125,
      resetsAt: seconds(nextWeek),
    };
    const quota = {
      status: 'allowed_warning',
      windows: { seven_day_opus: { utilization: 0.8125, percent: 81.25, resetsAt: nextWeek } },
    };
    expect(subscriptionQuota({ type: 'rate_limit_event', rate_limit_info: info })).toEqual(quota);
    expect(subscriptionQuota(info)).toEqual(quota);
  });

  it('keeps the windows of unifiedWindows over the one of rateLimitType', () => {
    expect(
      subscriptionQuota({
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'rejected',
          rateLimitType: 'five_hour',
          utilization: 0.5,
          unifiedWindows: { five_hour: { utilization: 1 } },
        },
      }),
    ).toEqual({ status: 'rejected', windows: { five_hour: { utilization: 1, percent: 100 } } });
  });

  it('bounds the utilization, and leaves out a window without one', () => {
    expect(
      subscriptionQuota({
        type: 'rate_limit_event',
        rate_limit_info: {
          unifiedWindows: {
            five_hour: { utilization: 1.2 },
            seven_day: { utilization: -0.1 },
            seven_day_sonnet: { resetsAt: seconds(nextWeek) },
            overage: 'unknown',
          },
        },
      }),
    ).toEqual({
      windows: {
        five_hour: { utilization: 1, percent: 100 },
        seven_day: { utilization: 0, percent: 0 },
      },
    });
  });

  it('keeps a window of any name as a window', () => {
    const event: unknown = JSON.parse(
      '{"type":"rate_limit_event","rate_limit_info":{"unifiedWindows":{"__proto__":{"utilization":0.5}}}}',
    );
    const windows = subscriptionQuota(event)?.windows ?? {};
    expect(Object.getPrototypeOf(windows)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(windows, '__proto__')?.value).toEqual({
      utilization: 0.5,
      percent: 50,
    });
  });

  it('gives the status of an event without windows', () => {
    expect(
      subscriptionQuota({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } }),
    ).toEqual({ status: 'rejected', windows: {} });
  });

  it.each([
    undefined,
    null,
    'rate_limit_event',
    [],
    { type: 'assistant' },
    { type: 'rate_limit_event' },
    { type: 'rate_limit_event', rate_limit_info: 'allowed' },
    { status: 'allowed' },
    { rateLimitType: 'five_hour', utilization: 0.5 },
  ])('reads nothing of %j', (event) => {
    expect(subscriptionQuota(event)).toBeUndefined();
  });
});
