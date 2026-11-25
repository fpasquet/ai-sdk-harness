import type { SandboxInfo, SandboxTimings } from '../protocol/api.js';

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
