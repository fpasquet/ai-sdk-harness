import type { ApprovalGrant, ToolRequest } from '../definitions/policy.js';

import { matchesCommand, matchesPath } from '../utils/patterns.js';
import { commandOf, toolKindOf } from '../utils/requests.js';
import { commandSegments } from '../utils/shell.js';

/** Commands whose second word names what they do: `git push`, `npm install`, `docker run`. */
const SUBCOMMANDS = new Set([
  'apt',
  'apt-get',
  'aws',
  'brew',
  'bun',
  'cargo',
  'deno',
  'docker',
  'dotnet',
  'gcloud',
  'gh',
  'git',
  'go',
  'kubectl',
  'npm',
  'npx',
  'pip',
  'pnpm',
  'poetry',
  'terraform',
  'uv',
  'yarn',
]);
/** Subcommands whose third word names what they run: `npm run test`, `pnpm exec vitest`. */
const RUNNERS = new Set(['dlx', 'exec', 'run', 'x']);
const WORD = /^[A-Za-z][\w:.-]*$/;

/** The prefix "always allow" grants for a command: `git push`, `npm run test`, `ls`. */
export function commandPrefix(command: string): string {
  const [name = '', second, third] = command.split(' ');
  if (!SUBCOMMANDS.has(name) || second === undefined || !WORD.test(second)) return name;
  if (RUNNERS.has(second) && third !== undefined && WORD.test(third)) {
    return `${name} ${second} ${third}`;
  }
  return `${name} ${second}`;
}

/** What "always allow" would grant for a tool call, and how a button says it. */
export interface GrantSuggestion {
  grants: ApprovalGrant[];
  /** `Always allow \`npm test\``, `Always allow file edits`. */
  label: string;
}

/**
 * What "always allow" grants for a tool call, for the rest of the session: the commands that
 * start like each of its commands, every file edit, or every call of the tool.
 */
export function suggestGrant({ toolName, input }: ToolRequest): GrantSuggestion {
  const kind = toolKindOf(toolName);
  if (kind === 'edit') return { grants: [{ kind: 'edit' }], label: 'Always allow file edits' };
  const command = kind === 'command' ? commandOf(toolName, input) : undefined;
  const prefixes = [
    ...new Set(commandSegments(command ?? '').map(({ command: part }) => commandPrefix(part))),
  ];
  if (prefixes.length === 0) {
    return { grants: [{ kind: 'tool', toolName }], label: `Always allow ${toolName}` };
  }
  return {
    grants: prefixes.map((prefix) => ({ kind: 'command', prefix })),
    label: `Always allow ${prefixes.map((prefix) => `\`${prefix}\``).join(', ')}`,
  };
}

/** How a reason names a grant: "`npm test` commands", "file edits". */
export function describeGrant(grant: ApprovalGrant): string {
  switch (grant.kind) {
    case 'command':
      return `\`${grant.prefix}\` commands`;
    case 'edit':
      return grant.path === undefined ? 'file edits' : `edits of \`${grant.path}\``;
    case 'tool':
      return `the tool ${grant.toolName}`;
  }
}

/** The grant among `grants` that allows a command, an edited path, or a call of a tool. */
export function grantFor(
  grants: readonly ApprovalGrant[],
  subject: { kind: 'command' | 'edit' | 'tool'; value: string },
): ApprovalGrant | undefined {
  return grants.find((grant) => {
    if (grant.kind !== subject.kind) return false;
    if (grant.kind === 'command') return matchesCommand(grant.prefix, subject.value);
    if (grant.kind === 'edit') {
      return grant.path === undefined || matchesPath(grant.path, subject.value);
    }
    return grant.toolName === subject.value;
  });
}

/** `grants` with `added`, each once: what to keep in the session after "always allow". */
export function withGrants(
  grants: readonly ApprovalGrant[] | undefined,
  added: readonly ApprovalGrant[],
): ApprovalGrant[] {
  const kept = [...(grants ?? [])];
  const keys = new Set(kept.map((grant) => JSON.stringify(grant)));
  for (const grant of added) {
    const key = JSON.stringify(grant);
    if (keys.has(key)) continue;
    keys.add(key);
    kept.push(grant);
  }
  return kept;
}
