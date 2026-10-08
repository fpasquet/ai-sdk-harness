/**
 * The shell snippets the service runs inside a sandbox. Each takes its inputs as positional
 * arguments (`sh -c SCRIPT $0 $1 …`), never spliced into the script, so no path or command is ever
 * parsed as shell code it was not meant to be.
 */

const KILL_TREE_FUNCTION =
  'kill_tree() { for child in $(pgrep -P "$1"); do kill_tree "$child"; done; kill -TERM "$1" 2>/dev/null; }';

/** Exit status of {@link KILL_TREE} when no pid is recorded in `$0`: not yet, or no longer. */
const KILL_TREE_UNRECORDED = 3;

/** Stops the process recorded in `$0` and everything it started, children first. */
export const KILL_TREE = `${KILL_TREE_FUNCTION}; pid=$(cat "$0" 2>/dev/null) || exit ${KILL_TREE_UNRECORDED}; kill_tree "$pid"; rm -f "$0"`;

/** Stops every process recorded in the directory `$0`. */
export const KILL_ALL = [
  KILL_TREE_FUNCTION,
  'for file in "$0"/*; do',
  '  [ -f "$file" ] || continue',
  '  pid=$(cat "$file" 2>/dev/null) && kill_tree "$pid"; rm -f "$file"',
  'done',
].join('\n');

/**
 * Makes the home `$0`, the working directory `$1`, and the service's state directory `$2` empty
 * with its process directory `$3` in it: a snapshot or a template brings back the pids of the
 * processes it ran, which mean nothing any more, and might name another process now.
 */
export const PREPARE = 'rm -rf "$2" && mkdir -p "$0" "$1" "$3"';
