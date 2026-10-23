/** A host a network policy cannot take: not a host name, nor `*.<domain>` for its subdomains. */
export class InvalidHostError extends Error {
  override readonly name = 'InvalidHostError';

  /** The host as it was given. */
  readonly host: string;

  constructor(host: string) {
    super(
      `"${host}" is not a host: write a host name, or *.<domain> for its subdomains, with no scheme, path nor port.`,
    );
    this.host = host;
  }
}
