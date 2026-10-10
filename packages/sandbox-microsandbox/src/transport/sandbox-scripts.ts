/**
 * The shell snippets run inside the sandbox. Each takes its inputs as positional arguments
 * (`sh -c SCRIPT $0 $1 …`), never spliced into the script, so no path or command is ever parsed
 * as shell code it was not meant to be.
 */

/** The sandbox's working directory, where a `workspace` of the host is mounted. */
export const WORKSPACE = '/workspace';

/** Exit status of {@link READ} for a path that does not exist. */
export const READ_MISSING = 44;
/** Exit status of {@link READ} for a path that is a directory. */
export const READ_DIRECTORY = 45;

/** `cat` the file `$0`, with exit statuses of its own for a missing path and for a directory. */
export const READ = `[ -d "$0" ] && exit ${READ_DIRECTORY}; [ -e "$0" ] || exit ${READ_MISSING}; exec cat -- "$0"`;

/** Writes stdin to the file `$0`, creating its parent directories. */
export const WRITE = 'mkdir -p "$(dirname "$0")" && cat > "$0"';

/** Creates the working directory `$0`, owned by the user `$1` when there is one. */
export const PREPARE_WORKSPACE = 'mkdir -p "$0" && { [ -z "$1" ] || chown "$1" "$0"; }';
