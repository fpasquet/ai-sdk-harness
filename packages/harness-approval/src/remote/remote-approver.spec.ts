import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApprovalVerdict } from '../definitions/policy.js';
import type { RemoteApprovalEvent, RemoteApprovalRequest } from './remote-approver.js';

import { remoteApprover } from './remote-approver.js';

const AT = new Date('2026-11-18T10:00:00.000Z');
const call = { approvalId: 'a1', toolName: 'Bash', input: { command: 'git push' } };

/** A remote interface: each request waits until the test answers it, or its signal aborts. */
function remote() {
  const asked: { request: RemoteApprovalRequest; signal: AbortSignal; context: unknown }[] = [];
  const answers = new Map<string, (verdict: ApprovalVerdict | undefined) => void>();
  return {
    asked,
    answer: (approvalId: string, verdict: ApprovalVerdict | undefined) =>
      answers.get(approvalId)?.(verdict),
    request: (
      request: RemoteApprovalRequest,
      { signal, context }: { signal: AbortSignal; context: unknown },
    ) => {
      asked.push({ request, signal, context });
      return new Promise<ApprovalVerdict | undefined>((resolve) =>
        answers.set(request.approvalId, resolve),
      );
    },
  };
}

describe('remoteApprover', () => {
  let events: RemoteApprovalEvent[];
  let ui: ReturnType<typeof remote>;
  const approver = (options: { timeoutMs?: number } = {}) =>
    remoteApprover<{ abortSignal?: AbortSignal; user?: string }>({
      request: ui.request,
      onEvent: (event) => events.push(event),
      now: () => AT,
      ...options,
    });

  beforeEach(() => {
    events = [];
    ui = remote();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks the remote interface, and resolves with its answer', async () => {
    const remoteApprovals = approver();
    const verdict = remoteApprovals.approve(call, { user: 'ada' });

    expect(ui.asked).toHaveLength(1);
    expect(ui.asked[0]?.context).toEqual({ user: 'ada' });
    expect(remoteApprovals.pending()).toEqual([
      {
        type: 'requested',
        approvalId: 'a1',
        toolName: 'Bash',
        input: { command: 'git push' },
        summary: { kind: 'command', title: 'Run a command', detail: 'git push' },
        at: AT.toISOString(),
      },
    ]);
    ui.answer('a1', { approved: false, reason: 'Not on Fridays.' });

    expect(await verdict).toEqual({ approved: false, reason: 'Not on Fridays.' });
    expect(remoteApprovals.pending()).toEqual([]);
    expect(events.map(({ type }) => type)).toEqual(['requested', 'answered']);
    expect(events[1]).toEqual({
      type: 'answered',
      approvalId: 'a1',
      approved: false,
      reason: 'Not on Fridays.',
      at: AT.toISOString(),
    });
  });

  it('sends events that survive JSON as they are', async () => {
    const remoteApprovals = approver();
    const verdict = remoteApprovals.approve(call);
    ui.answer('a1', { approved: true });
    await verdict;

    expect(JSON.parse(JSON.stringify(events))).toEqual(events);
  });

  it('abandons an approval on request, aborting the signal of the remote interface', async () => {
    const remoteApprovals = approver();
    const verdict = remoteApprovals.approve(call);

    expect(remoteApprovals.abandon('a1')).toBe(true);

    expect(await verdict).toBeUndefined();
    expect(ui.asked[0]?.signal.aborted).toBe(true);
    expect(events.at(-1)).toEqual({
      type: 'abandoned',
      approvalId: 'a1',
      reason: 'abandoned',
      at: AT.toISOString(),
    });
    expect(remoteApprovals.abandon('a1')).toBe(false);
    ui.answer('a1', { approved: true });
    expect(events.map(({ type }) => type)).toEqual(['requested', 'abandoned']);
  });

  it("abandons an approval when the caller's signal aborts", async () => {
    const remoteApprovals = approver();
    const turn = new AbortController();
    const verdict = remoteApprovals.approve(call, { abortSignal: turn.signal });

    turn.abort();

    expect(await verdict).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ type: 'abandoned', reason: 'aborted' });
    expect(ui.asked[0]?.signal.aborted).toBe(true);
  });

  it('asks nothing for a caller whose signal aborted already', async () => {
    const remoteApprovals = approver();

    expect(await remoteApprovals.approve(call, { abortSignal: AbortSignal.abort() })).toBe(
      undefined,
    );
    expect(ui.asked).toEqual([]);
    expect(events.map((event) => [event.type, 'reason' in event && event.reason])).toEqual([
      ['requested', false],
      ['abandoned', 'aborted'],
    ]);
  });

  it('abandons an approval nobody answered in time', async () => {
    vi.useFakeTimers();
    const remoteApprovals = approver({ timeoutMs: 1000 });
    const verdict = remoteApprovals.approve(call);

    await vi.advanceTimersByTimeAsync(1000);

    expect(await verdict).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ type: 'abandoned', reason: 'timeout' });
  });

  it('tells an approval the interface left undecided', async () => {
    const remoteApprovals = approver();
    const verdict = remoteApprovals.approve(call);
    ui.answer('a1', undefined);

    expect(await verdict).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ type: 'abandoned', reason: 'undecided' });
  });

  it('abandons an approval the interface failed to ask, and throws', async () => {
    const remoteApprovals = remoteApprover({
      request: () => Promise.reject(new Error('offline')),
      onEvent: (event) => events.push(event),
    });

    await expect(remoteApprovals.approve(call)).rejects.toThrow('offline');
    expect(events.at(-1)).toMatchObject({ type: 'abandoned', reason: 'failed' });
    expect(remoteApprovals.pending()).toEqual([]);
  });

  it('waits once per approval: the same one asked again abandons the first', async () => {
    const remoteApprovals = approver();
    const first = remoteApprovals.approve(call);
    const second = remoteApprovals.approve(call);

    expect(await first).toBeUndefined();
    expect(remoteApprovals.pending()).toHaveLength(1);
    ui.answer('a1', { approved: true });
    expect(await second).toEqual({ approved: true });
  });

  it('keeps several approvals apart, the oldest first', async () => {
    const remoteApprovals = approver();
    const first = remoteApprovals.approve(call);
    const second = remoteApprovals.approve({ ...call, approvalId: 'a2' });

    expect(remoteApprovals.pending().map(({ approvalId }) => approvalId)).toEqual(['a1', 'a2']);
    ui.answer('a2', { approved: true });
    ui.answer('a1', { approved: false });

    expect(await first).toEqual({ approved: false });
    expect(await second).toEqual({ approved: true });
  });

  it('calls each subscriber until it unsubscribes, whatever another throws', async () => {
    const remoteApprovals = approver();
    const seen: string[] = [];
    remoteApprovals.subscribe(() => {
      throw new Error('broken listener');
    });
    const unsubscribe = remoteApprovals.subscribe((event) => seen.push(event.type));

    const verdict = remoteApprovals.approve(call);
    unsubscribe();
    ui.answer('a1', { approved: true });

    expect(await verdict).toEqual({ approved: true });
    expect(seen).toEqual(['requested']);
    expect(events.map(({ type }) => type)).toEqual(['requested', 'answered']);
  });
});
