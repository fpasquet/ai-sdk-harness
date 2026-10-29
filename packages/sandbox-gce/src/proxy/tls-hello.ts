/** What the first bytes of a tunnel say of the TLS connection they open. */
export type ClientHello =
  /** A ClientHello, read whole: the server it names, if it names one. */
  | { kind: 'hello'; serverName?: string }
  /** More bytes are needed to read it whole. */
  | { kind: 'incomplete' }
  /** Not a TLS ClientHello: another protocol, or a malformed one. */
  | { kind: 'invalid' };

const HANDSHAKE_RECORD = 22;
const CLIENT_HELLO = 1;
const SERVER_NAME_EXTENSION = 0;
const HOST_NAME = 0;

const INCOMPLETE: ClientHello = { kind: 'incomplete' };
const INVALID: ClientHello = { kind: 'invalid' };

/**
 * The handshake bytes the TLS records at the start of `data` carry, put back together: a
 * ClientHello may span several records. `undefined` when a record is no handshake one.
 */
function handshakeBytes(data: Buffer): Buffer | undefined {
  const fragments: Buffer[] = [];
  let offset = 0;
  while (offset + 5 <= data.length) {
    if (data[offset] !== HANDSHAKE_RECORD || data[offset + 1] !== 3) return undefined;
    const length = data.readUInt16BE(offset + 3);
    if (offset + 5 + length > data.length) break;
    fragments.push(data.subarray(offset + 5, offset + 5 + length));
    offset += 5 + length;
  }
  return Buffer.concat(fragments);
}

/** A reader of the fields of a ClientHello, which fails on any length past its end. */
class Fields {
  private offset = 0;

  constructor(private readonly bytes: Buffer) {}

  skip(length: number): void {
    if (this.offset + length > this.bytes.length) throw new RangeError('Past the end');
    this.offset += length;
  }

  uint(size: 1 | 2): number {
    const value = size === 1 ? this.bytes[this.offset] : this.bytes.readUInt16BE(this.offset);
    this.skip(size);
    return value ?? 0;
  }

  /** The `length` bytes that follow, as a reader of their own. */
  take(length: number): Fields {
    const start = this.offset;
    this.skip(length);
    return new Fields(this.bytes.subarray(start, start + length));
  }

  get done(): boolean {
    return this.offset === this.bytes.length;
  }

  text(): string {
    return this.bytes.toString('latin1');
  }
}

/** The host name of a `server_name` extension (RFC 6066), if it carries one. */
function hostNameOf(extension: Fields): string | undefined {
  const names = extension.take(extension.uint(2));
  while (!names.done) {
    const type = names.uint(1);
    const name = names.take(names.uint(2));
    if (type === HOST_NAME) return name.text();
  }
  return undefined;
}

/** The server a whole ClientHello handshake message names (RFC 8446, section 4.1.2). */
function serverNameOf(hello: Fields): string | undefined {
  hello.skip(2 + 32); // legacy_version, random
  hello.skip(hello.uint(1)); // legacy_session_id
  hello.skip(hello.uint(2)); // cipher_suites
  hello.skip(hello.uint(1)); // legacy_compression_methods
  if (hello.done) return undefined;
  const extensions = hello.take(hello.uint(2));
  while (!extensions.done) {
    const type = extensions.uint(2);
    const data = extensions.take(extensions.uint(2));
    if (type === SERVER_NAME_EXTENSION) return hostNameOf(data);
  }
  return undefined;
}

/**
 * Reads the ClientHello a client opens a TLS connection with, from the first bytes it sent: what
 * the egress proxy checks before it lets a tunnel's bytes through.
 */
export function readClientHello(data: Buffer): ClientHello {
  if (data.length === 0) return INCOMPLETE;
  if (data[0] !== HANDSHAKE_RECORD) return INVALID;
  const bytes = handshakeBytes(data);
  if (bytes === undefined) return INVALID;
  if (bytes.length < 4) return INCOMPLETE;
  if (bytes[0] !== CLIENT_HELLO) return INVALID;
  const length = bytes.readUIntBE(1, 3);
  if (bytes.length < 4 + length) return INCOMPLETE;
  try {
    const serverName = serverNameOf(new Fields(bytes.subarray(4, 4 + length)));
    return serverName === undefined ? { kind: 'hello' } : { kind: 'hello', serverName };
  } catch {
    return INVALID;
  }
}
