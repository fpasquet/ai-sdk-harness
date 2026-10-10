import type { SrtRuntimeSettings } from '../src/index.js';

/**
 * srt's settings for the end-to-end tests, from the environment: `SRT_SOCAT` and `SRT_RIPGREP`
 * for binaries off the `PATH`, `SRT_ALLOW_ALL_UNIX_SOCKETS=1` where user namespaces are restricted
 * (Ubuntu 24.04 and later), which srt's seccomp filter needs.
 */
export const RUNTIME: SrtRuntimeSettings = {
  ...(process.env.SRT_SOCAT !== undefined && { socatPath: process.env.SRT_SOCAT }),
  ...(process.env.SRT_RIPGREP !== undefined && { ripgrepPath: process.env.SRT_RIPGREP }),
  ...(process.env.SRT_ALLOW_ALL_UNIX_SOCKETS === '1' && { allowAllUnixSockets: true }),
};
