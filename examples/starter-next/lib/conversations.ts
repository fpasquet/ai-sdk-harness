import type { ApprovalGrant } from 'ai-sdk-harness-approval';
import type { SessionStatus } from 'ai-sdk-harness-sessions';

import type { HarnessId } from '@/lib/harnesses';
import type { SandboxId } from '@/lib/sandboxes';

/**
 * What the example keeps with each session, its metadata: the agent the conversation picked
 * before its first message, kept for the whole conversation. Shared by the page and the server.
 */
export interface Conversation {
  harness: HarnessId;
  model: string;
  /** The ids of what it picked in the marketplace: plugins, and items on their own. */
  selection: string[];
  /**
   * Whether the agent follows the example's approval policy (`APPROVAL_POLICY`): what it allows
   * runs, what it denies is refused, and the rest waits for your approval.
   */
  askFirst: boolean;
  /** What you allowed for the rest of the conversation, with "Always allow". */
  grants?: ApprovalGrant[];
  /** The first message, shortened: what the list of conversations shows. */
  title: string;
  /** The sandbox it runs in, `EXAMPLE_SANDBOX` when it started: none for one started before. */
  sandbox?: SandboxId;
  /** How long each turn took, by the id of the agent's message it wrote. */
  timings?: Record<string, TurnTimings>;
}

/** The last sandbox opening among the timings of a conversation's turns: what the list shows. */
export function lastSandboxOpening(
  timings: Conversation['timings'],
): TurnTimings['sandbox'] | undefined {
  return Object.values(timings ?? {}).findLast(({ sandbox }) => sandbox !== undefined)?.sandbox;
}

/**
 * How long a turn took, in milliseconds, from the moment the server got the message: what the page
 * shows under the agent's answer.
 */
export interface TurnTimings {
  /** The sandbox opened for this turn: created (from the template) or resumed. None when it ran. */
  sandbox?: { kind: 'created' | 'resumed'; ms: number };
  /** Until the session was ready: the sandbox, then the harness session in it. */
  ready: number;
  /** From then until the agent's first output: its first words, thoughts or tool call. */
  firstOutput?: number;
  /** From the session ready to the end of the turn. */
  turn: number;
  /** From the message to the end of the turn. */
  total: number;
}

/** How each status reads in the list of conversations. */
export const STATUS_LABELS: Record<SessionStatus, string> = {
  preparing: 'Preparing',
  idle: 'Ready',
  busy: 'Working',
  'awaiting-input': 'Needs you',
  suspended: 'Suspended',
  closed: 'Closed',
  failed: 'Failed',
  interrupted: 'Interrupted',
};

/** A conversation's title, from its first message. */
export const titleOf = (text: string): string => {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > 60 ? `${line.slice(0, 57)}…` : line || 'New conversation';
};
