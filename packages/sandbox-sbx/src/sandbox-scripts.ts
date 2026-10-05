/**
 * The shell snippets run inside the sandbox. Each takes its inputs as positional arguments
 * (`sh -c SCRIPT $0 $1 …`), never spliced into the script, so no path or command is ever parsed
 * as shell code it was not meant to be.
 */

/** Where a spawned process leaves its pid, so it can be stopped from outside. */
export const PROCESS_DIR = '/tmp/.ai-sdk-sbx-processes';

/**
 * Runs `$1` under a shell whose pid is recorded in `$0` first. Killing the `sbx exec` client does
 * not reach the process inside the sandbox, so this pid is the only handle on it.
 */
export const TRACKED = `mkdir -p ${PROCESS_DIR} && echo $$ > "$0" && sh -c "$1"; code=$?; rm -f "$0"; exit $code`;

/** Stops the process recorded in `$0` and everything it started, children first. */
export const KILL_TREE =
  'kill_tree() { for child in $(pgrep -P "$1"); do kill_tree "$child"; done; kill -TERM "$1" 2>/dev/null; }; ' +
  'pid=$(cat "$0" 2>/dev/null) && kill_tree "$pid"; rm -f "$0"';

/**
 * Stops every process recorded in {@link PROCESS_DIR}, whichever session started it, sparing the
 * shells running this very script, which `sbx exec` started like any other.
 */
export const KILL_ALL = [
  'kill_tree() { for child in $(pgrep -P "$1"); do kill_tree "$child"; done; kill -TERM "$1" 2>/dev/null; }',
  'mine=" $$ "; p=$$',
  'while [ "$p" -gt 1 ] 2>/dev/null; do p=$(ps -o ppid= -p "$p" | tr -d " "); mine="$mine$p "; done',
  `for file in ${PROCESS_DIR}/*; do`,
  '  [ -f "$file" ] || continue',
  '  pid=$(cat "$file" 2>/dev/null) || continue',
  '  case "$mine" in *" $pid "*) continue ;; esac',
  '  kill_tree "$pid"; rm -f "$file"',
  'done',
  'true',
].join('\n');

/** Exit status of {@link READ} for a path that does not exist. */
export const READ_MISSING = 44;
/** Exit status of {@link READ} for a path that is a directory. */
export const READ_DIRECTORY = 45;

/** `cat` the file `$0`, with exit statuses of its own for a missing path and for a directory. */
export const READ = `[ -d "$0" ] && exit ${READ_DIRECTORY}; [ -e "$0" ] || exit ${READ_MISSING}; exec cat -- "$0"`;

/** Writes stdin to the file `$0`, creating its parent directories. */
export const WRITE = 'mkdir -p "$(dirname "$0")" && cat > "$0"';

/** The sandbox's working directory on the first line, then its environment. */
export const PROBE = 'pwd; env';
