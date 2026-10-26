/**
 * The version of the HTTP APIs of the package: between the client and the sandbox service, and
 * between the service, the agent of each machine and the egress proxy. Every side of one release
 * speaks the same; a side that speaks another one is refused, rather than answered with errors
 * nobody could make sense of.
 */
export const PROTOCOL_VERSION = 1;

/** The header a caller names its protocol version in, and the callee answers with its own. */
export const PROTOCOL_HEADER = 'x-ai-sdk-sandbox-protocol';

/** The header carrying the secret the client and the service may share, beside Cloud Run's IAM. */
export const SERVICE_TOKEN_HEADER = 'x-ai-sdk-sandbox-token';
