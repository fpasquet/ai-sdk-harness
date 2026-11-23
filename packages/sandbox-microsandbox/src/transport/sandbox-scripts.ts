/**
 * The shell snippets run inside the sandbox. Each takes its inputs as positional arguments
 * (`sh -c SCRIPT $0 $1 …`), never spliced into the script, so no path or command is ever parsed
 * as shell code it was not meant to be.
 */

/**
 * Runs the command `$1` with bash, as the AI SDK's Vercel sandbox does and the harnesses expect (Pi
 * writes bash), or with sh in an image without bash.
 */
export const COMMAND =
  'if command -v bash >/dev/null 2>&1; then exec bash -c "$1"; fi; exec sh -c "$1"';

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

/** Exit status of {@link LIST} for a path that is not a directory. */
export const NOT_DIRECTORY = 46;

/**
 * The type of the path `$0`, symbolic links followed, then its size in bytes: `file 12`. Exits
 * {@link READ_MISSING} for a path that does not exist.
 */
export const STAT =
  `[ -e "$0" ] || exit ${READ_MISSING}; ` +
  'if [ -d "$0" ]; then t=directory; elif [ -f "$0" ]; then t=file; else t=other; fi; ' +
  's=$(stat -L -c %s -- "$0" 2>/dev/null || wc -c < "$0" 2>/dev/null || echo 0); echo "$t" $s';

/**
 * Every entry of the directory `$0` as `<type> <name>`, each ended by a NUL: a name may hold any
 * other byte. Symbolic links are reported as such, not followed. Exits {@link READ_MISSING} for a
 * path that does not exist and {@link NOT_DIRECTORY} for one that is not a directory.
 */
export const LIST =
  `[ -d "$0" ] || { [ -e "$0" ] && exit ${NOT_DIRECTORY}; exit ${READ_MISSING}; }; cd -- "$0" || exit 1; ` +
  'for f in * .[!.]* ..?*; do ' +
  'if [ -L "$f" ]; then t=symlink; elif [ -d "$f" ]; then t=directory; elif [ -f "$f" ]; then t=file; ' +
  'elif [ -e "$f" ]; then t=other; else continue; fi; ' +
  'printf \'%s %s\\0\' "$t" "$f"; done';

/**
 * Deletes the file `$0`, a symbolic link itself rather than its target. Exits {@link READ_MISSING}
 * for a path that does not exist and {@link READ_DIRECTORY} for a directory.
 */
export const DELETE =
  `if [ -L "$0" ]; then :; elif [ -d "$0" ]; then exit ${READ_DIRECTORY}; elif [ ! -e "$0" ]; then exit ${READ_MISSING}; fi; ` +
  'exec rm -f -- "$0"';

/** Creates the working directory `$0`, owned by the user `$1` when there is one. */
export const PREPARE_WORKSPACE = 'mkdir -p "$0" && { [ -z "$1" ] || chown "$1" "$0"; }';

/** Where a sandbox made with Docker records the group its daemon's socket belongs to. */
export const DOCKER_MARKER = '/etc/ai-sdk-harness/docker-group';

/** The Docker daemon's log. */
export const DOCKER_LOG = '/var/log/dockerd.log';

/** The Docker daemon's data, on an ext4 disk of its own: overlay2 cannot nest in the rootfs's overlay. */
export const DOCKER_DATA = '/var/lib/docker';

/**
 * Installs Docker Engine and its Compose plugin with Docker's own script unless the image has a
 * daemon, then records in `$0` the group of the user `$1`, which the daemon's socket is given to.
 */
export const INSTALL_DOCKER =
  'command -v dockerd >/dev/null 2>&1 || { curl -fsSL https://get.docker.com -o /tmp/get-docker.sh' +
  ' && sh /tmp/get-docker.sh && rm -f /tmp/get-docker.sh; }' +
  ' && mkdir -p "$(dirname "$0")" && { if [ -n "$1" ]; then id -gn "$1"; else echo root; fi; } > "$0"';

/**
 * Runs the Docker daemon, its socket given to the group recorded in `$0`, logging to `$1`, unless
 * one runs. `/run` lives on the sandbox's disk: the pid files of a daemon the last stop ended name
 * a pid another process may hold now, and would keep the new one from starting.
 */
export const START_DOCKER =
  'for comm in /proc/[0-9]*/comm; do [ "$(cat "$comm" 2>/dev/null)" = dockerd ] && exit 0; done;' +
  ' rm -f /var/run/docker.pid /var/run/docker/containerd/containerd.pid;' +
  ' exec dockerd --group "$(cat "$0")" >>"$1" 2>&1';

/** Waits up to a minute for the Docker daemon to answer, then prints the end of its log `$0`. */
export const AWAIT_DOCKER =
  'i=0; until docker info >/dev/null 2>&1; do i=$((i + 1));' +
  ' if [ "$i" -gt 120 ]; then tail -n 20 "$0" >&2; exit 1; fi; sleep 0.5; done';

/** Exits 0 when the file `$0` exists. */
export const EXISTS = '[ -e "$0" ]';
