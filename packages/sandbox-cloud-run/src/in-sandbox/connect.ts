import { connect } from 'node:net';

/**
 * Runs inside a sandbox: joins its standard input and output to a port of the sandbox's own
 * loopback. What lets the service reach a server in the sandbox, such as a harness bridge, through
 * a `sandbox exec`, whatever network the sandbox has.
 *
 * Usage: `node connect.js <port>`. Exits once either side is done.
 */
const port = Number(process.argv[2]);
const socket = connect({ port, host: '127.0.0.1' });

process.stdin.pipe(socket);
socket.pipe(process.stdout);
socket.once('error', (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
socket.once('close', () => process.exit(0));
process.stdin.once('end', () => socket.end());
