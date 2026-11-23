/**
 * The windows Claude Code counts the use of a subscription in, as its `rate_limit_event` names
 * them. Others may come: {@link SubscriptionQuota.windows} keeps every window an event gives.
 */
export type QuotaWindowName =
  | 'five_hour'
  | 'overage'
  | 'seven_day'
  | 'seven_day_opus'
  | 'seven_day_overage_included'
  | 'seven_day_sonnet';

/** How much of one window of the subscription is used. */
export interface QuotaWindow {
  /** The share of the window used, from 0 to 1. */
  utilization: number;
  /** The same share as a percentage, from 0 to 100, to two decimals. */
  percent: number;
  /** When the window starts again from zero, when the event says. */
  resetsAt?: Date;
}

/** Whether the subscription takes more requests, as Claude Code says. */
export type QuotaStatus = 'allowed' | 'allowed_warning' | 'rejected';

/** The use of a subscription, as one `rate_limit_event` of Claude Code gives it. */
export interface SubscriptionQuota {
  /**
   * `allowed`, `allowed_warning` once a window nears its limit, or `rejected` once one is reached;
   * absent when the event does not say.
   */
  status?: QuotaStatus;
  /**
   * The windows the event gives, by name ({@link QuotaWindowName}): `five_hour`, `seven_day`… An
   * event of the Claude Code CLI gives every window; one of the Claude Agent SDK may give one.
   */
  windows: Partial<Record<string, QuotaWindow>>;
}

const STATUSES = new Set<unknown>(['allowed', 'allowed_warning', 'rejected']);

type Fields = Record<string, unknown>;

const isFields = (value: unknown): value is Fields =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A window of the event: its utilization a fraction, its reset time in seconds. */
function windowOf(utilization: unknown, resetsAt: unknown): QuotaWindow | undefined {
  if (typeof utilization !== 'number' || !Number.isFinite(utilization)) return undefined;
  const used = Math.min(1, Math.max(0, utilization));
  return {
    utilization: used,
    percent: Math.round(used * 10_000) / 100,
    ...(typeof resetsAt === 'number' &&
      Number.isFinite(resetsAt) && { resetsAt: new Date(resetsAt * 1000) }),
  };
}

/**
 * The rate limit information of `event`: the `rate_limit_info` of a `rate_limit_event`, or an
 * `SDKRateLimitInfo` of the Claude Agent SDK given as it is.
 */
function infoOf(event: unknown): Fields | undefined {
  if (!isFields(event)) return undefined;
  if (event.type === 'rate_limit_event') {
    return isFields(event.rate_limit_info) ? event.rate_limit_info : undefined;
  }
  const isInfo =
    STATUSES.has(event.status) && ('unifiedWindows' in event || 'rateLimitType' in event);
  return isInfo ? event : undefined;
}

/**
 * The use of a Claude subscription, read from one raw event of Claude Code: its windows (five
 * hours, seven days…), how much of each is used, and when each starts again from zero. `undefined`
 * for any other event.
 *
 * It reads the `rate_limit_event` Claude Code sends during each turn when it is signed in with a
 * subscription, as the CLI's `stream-json` output and `@ai-sdk/harness-claude-code`'s raw events
 * carry it: every window in `rate_limit_info.unifiedWindows`, the one window of the Claude Agent
 * SDK's `SDKRateLimitInfo` (`rateLimitType`, `utilization`, `resetsAt`) otherwise. An
 * `SDKRateLimitInfo` is read as well on its own. A window without its utilization is left out.
 */
export function subscriptionQuota(event: unknown): SubscriptionQuota | undefined {
  const info = infoOf(event);
  if (info === undefined) return undefined;
  // A Map, then fromEntries: a window named `__proto__` stays a window.
  const windows = new Map<string, QuotaWindow>();
  if (isFields(info.unifiedWindows)) {
    for (const [name, value] of Object.entries(info.unifiedWindows)) {
      const window = isFields(value) ? windowOf(value.utilization, value.resetsAt) : undefined;
      if (window !== undefined) windows.set(name, window);
    }
  }
  if (typeof info.rateLimitType === 'string' && !windows.has(info.rateLimitType)) {
    const window = windowOf(info.utilization, info.resetsAt);
    if (window !== undefined) windows.set(info.rateLimitType, window);
  }
  return {
    ...(STATUSES.has(info.status) && { status: info.status as QuotaStatus }),
    windows: Object.fromEntries(windows),
  };
}
