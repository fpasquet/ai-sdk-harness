# Security Policy

## Supported versions

Only the latest minor version of each package is actively supported with security fixes.

## Security model of `ai-sdk-sandbox-sbx`

The package exists to keep a coding agent away from the host. What it guarantees:

- Every command and file operation runs inside the Docker Sandbox microVM, through `sbx exec`. The package never runs agent-supplied input in a host shell: every `sbx` argument is passed as-is to `spawn`, and in-sandbox scripts receive paths and commands as positional arguments, never spliced into the script.
- Environment variables a command sets are forwarded by name (`sbx exec -e NAME`), so their values never appear on a command line.
- With credential brokering on (the default), the real credential never enters the sandbox: the Docker Sandboxes proxy swaps a placeholder for it on the way out. The value does appear on the host's process list, as an `sbx secret set-custom --value` argument, for the time that command runs.
- Ports are published on `127.0.0.1` only.

What it does not cover: the isolation of the microVM itself and the network policy belong to Docker Sandboxes: report issues with them to Docker. A host directory mounted with `workspace` is writable by the agent by design.

## Reporting a vulnerability

Please do not open a public issue for security vulnerabilities.

Open a [GitHub Security Advisory](https://github.com/fpasquet/ai-sdk-harness/security/advisories/new) with:

- Affected package and version.
- Vulnerability description.
- Reproduction steps or proof of concept.
- Potential impact.

We aim to acknowledge reports within 72 hours.
