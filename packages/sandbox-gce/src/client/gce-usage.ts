import type {
  MetricSample,
  SandboxEgressUsage,
  SandboxInfo,
  SandboxMetrics,
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

/**
 * What the agent of a sandbox's machine read of it at one instant, from `/proc`: CPU, memory, their
 * pressure, the processes killed for want of memory. Read in the machine, where the sandbox's user
 * has `sudo`: fit for sizing the machines, never for billing.
 */
export type GceSandboxMetricSample = MetricSample;

/**
 * The samples of a sandbox's machine, oldest first, taken every `intervalSeconds`: what `metrics()`
 * of a session and `getGceSandboxMetrics()` answer, and the `metrics` of a {@link GceSandboxReport}.
 */
export type GceSandboxMetrics = SandboxMetrics;
