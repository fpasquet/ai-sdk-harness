import type {
  SandboxEgressUsage,
  SandboxInfo,
  SandboxReport,
  SandboxTimings,
} from '../protocol/api.js';

/**
 * A sandbox's machine, as Compute Engine describes it: when it ran, how it is billed (Spot or
 * standard), what it is made of, and the labels it holds. What `describeGceSandbox()` and
 * `describe()` of a session answer, running or stopped.
 */
export type GceSandboxInfo = SandboxInfo;

/**
 * How long the creation or the resume of a sandbox took on the service, in milliseconds, step by
 * step: the egress proxy, Compute Engine making or starting the machine (or taking one of the warm
 * pool), its boot until the agent answered, then the agent's configuration. `timings` of a session.
 */
export type GceSandboxTimings = SandboxTimings;

/**
 * The bytes a sandbox's connections carried through the egress proxy since its creation or its last
 * resume from a stop, counted outside the machine: `usage()` of a session and `getGceSandboxUsage()`
 * read it while the sandbox runs. The proxy keeps it in memory only, and forgets it with the
 * sandbox: a suspension or a deletion answers the last one, in a {@link GceSandboxReport}.
 */
export type GceSandboxEgressUsage = SandboxEgressUsage;

/**
 * The last measures of a sandbox, read by the service as it suspends or deletes it, before they are
 * lost: what `onUsageReport` is handed when a session stops or destroys it or `deleteGceSandbox()`
 * deletes it, and what `lastReport` of the session holds then.
 */
export type GceSandboxReport = SandboxReport;
