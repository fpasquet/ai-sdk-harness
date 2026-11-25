import type { SandboxInfo } from '../protocol/api.js';

/**
 * A sandbox's machine, as Compute Engine describes it: when it ran, how it is billed (Spot or
 * standard), what it is made of, and the labels it holds. What `describeGceSandbox()` and
 * `describe()` of a session answer, running or stopped.
 */
export type GceSandboxInfo = SandboxInfo;
