/**
 * The version of the HTTP API between the client and the sandbox service. Both sides of one
 * release of the package speak the same; the service refuses a client that speaks another one,
 * rather than answering it with errors nobody could make sense of.
 */
export const PROTOCOL_VERSION = 1;

/** The header the client names its protocol version in, and the service answers with its own. */
export const PROTOCOL_HEADER = 'x-ai-sdk-sandbox-protocol';

/** The header carrying the secret the client and the service may share, beside Cloud Run's IAM. */
export const SERVICE_TOKEN_HEADER = 'x-ai-sdk-sandbox-token';
