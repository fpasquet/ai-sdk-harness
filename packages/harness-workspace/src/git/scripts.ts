/**
 * The scripts the workspace runs in the sandbox, each with its inputs as positional parameters.
 * Every one of them runs after the prelude of `runScript`: `set -e`, and a `git` that runs none of
 * the repository's hooks.
 */

/** The common directory of the checkout `$1`, resolved: the repository it is a worktree of. */
const COMMON_DIR =
  'common() { (cd "$(git -C "$1" rev-parse --path-format=absolute --git-common-dir)" && pwd -P); }';

/** `$1`, or the default repository named `$2` in the user's home: prints the path. */
export const LOCATE = 'printf "%s" "${1:-$HOME/.ai-sdk-harness/repositories/$2.git}"';

/**
 * Creates the bare repository `$1` unless it exists, and gives it the identity `$2 <$3>` for the
 * agents' commits unless git already has one.
 */
export const INIT = [
  '[ -f "$1/HEAD" ] || { mkdir -p "$1"; git init --quiet --bare "$1"; }',
  'git -C "$1" config user.name >/dev/null || git -C "$1" config user.name "$2"',
  'git -C "$1" config user.email >/dev/null || git -C "$1" config user.email "$3"',
].join('\n');

/**
 * Fetches revision `$3` of `$2` — a URL, a repository's path, a bundle — into ref `$4` of the
 * repository `$1`, `$5` commits deep when set.
 */
export const FETCH = [
  'git -C "$1" fetch --quiet --no-tags --no-write-fetch-head ${5:+"--depth=$5"} "$2" "+$3:$4"',
  'git -C "$1" rev-parse --verify --quiet "$4^{commit}" >/dev/null',
].join('\n');

/**
 * Whether the repository `$1` has commit `$2`: if so, points ref `$3` at it and prints `present`;
 * otherwise prints the commits its refs hold, for a bundle to leave out.
 */
export const HAS_COMMIT = [
  'if git -C "$1" cat-file -e "$2^{commit}" 2>/dev/null; then',
  '  git -C "$1" update-ref "$3" "$2"',
  '  echo present',
  '  exit 0',
  'fi',
  'git -C "$1" for-each-ref --format="%(objectname)" refs/',
].join('\n');

/**
 * Checks the commit at ref `$4` of repository `$1` out in `$2`, a worktree on branch `$3`, and
 * keeps that commit at ref `$5`: prints it. A checkout of the same repository already in `$2` — a
 * start that failed after it, tried again — is kept as it is.
 */
export const CHECKOUT = [
  'repo=$1 dir=$2 branch=$3 fetched=$4 base=$5',
  COMMON_DIR,
  'git check-ref-format --branch "$branch" >/dev/null',
  'if [ -e "$dir/.git" ]; then',
  '  if [ "$(common "$dir" 2>/dev/null)" = "$(cd "$repo" && pwd -P)" ] &&',
  '    git -C "$repo" rev-parse --verify --quiet "$base^{commit}" >/dev/null; then',
  '    git -C "$repo" update-ref -d "$fetched" 2>/dev/null || true',
  '    git -C "$repo" rev-parse "$base^{commit}"',
  '    exit 0',
  '  fi',
  '  echo "$dir holds a checkout of another repository" >&2',
  '  exit 3',
  'fi',
  'if [ -n "$(ls -A "$dir" 2>/dev/null)" ]; then',
  '  echo "$dir is not empty: the checkout must be made before anything is written there" >&2',
  '  exit 3',
  'fi',
  'commit=$(git -C "$repo" rev-parse --verify "$fetched^{commit}")',
  'git -C "$repo" update-ref "$base" "$commit"',
  'git -C "$repo" update-ref -d "$fetched"',
  'git -C "$repo" worktree prune',
  'git -C "$repo" worktree add --quiet -B "$branch" "$dir" "$commit"',
  'printf "%s\\n" "$commit"',
].join('\n');

/**
 * Whether `$2` still holds a checkout of repository `$1` whose base, ref `$3`, is still there:
 * prints that base, or exits with 2.
 */
export const REATTACH = [
  COMMON_DIR,
  '[ -e "$2/.git" ] || exit 2',
  '[ "$(common "$2" 2>/dev/null)" = "$(cd "$1" 2>/dev/null && pwd -P)" ] || exit 2',
  'git -C "$1" rev-parse --verify --quiet "$3^{commit}" || exit 2',
].join('\n');

/**
 * Stages everything in the checkout `$1` on a copy of its index — the agent's own index stays as it
 * is — for the command that follows to compare with `$2`.
 */
const STAGE_ALL = [
  'cd "$1"',
  'gitdir=$(git rev-parse --absolute-git-dir)',
  'index="$gitdir/ai-sdk-harness-$$.index"',
  'trap \'rm -f "$index"\' EXIT',
  // With its timestamp: git takes a file as racily clean, to be read again, by the index's mtime.
  'cp -p "$gitdir/index" "$index" 2>/dev/null || true',
  'GIT_INDEX_FILE=$index git add --all',
].join('\n');

/**
 * Writes what changed in the checkout `$1` since commit `$2` as a binary patch, its paths under
 * `$3` — empty, or a directory and a slash —, its prefixes spelt out so that the repository's
 * configuration cannot reshape it, and prints the file's path.
 */
export const CHANGES = [
  STAGE_ALL,
  'out="$gitdir/ai-sdk-harness-$$.patch"',
  'GIT_INDEX_FILE=$index git diff --cached --binary --full-index --no-color --no-ext-diff \\',
  '  --no-textconv --find-renames --src-prefix="a/$3" --dst-prefix="b/$3" "$2^{commit}" > "$out"',
  'printf "%s" "$out"',
].join('\n');

/** Lists what changed in the checkout `$1` since commit `$2`: `--raw` and `--numstat`, `-z`. */
export const CHANGED_FILES = [
  STAGE_ALL,
  'GIT_INDEX_FILE=$index git diff --cached --no-renames --raw --numstat -z "$2^{commit}"',
].join('\n');

/**
 * Keeps path `$2` of the checkout `$1` out of its changes: ignored with pattern `$3` when the
 * repository has no such file, its edits hidden from git when it has one.
 */
export const KEEP_LOCAL = [
  'cd "$1"',
  'exclude=$(git rev-parse --git-path info/exclude)',
  'mkdir -p "$(dirname "$exclude")"',
  'grep -qxF -- "$3" "$exclude" 2>/dev/null || printf "%s\\n" "$3" >> "$exclude"',
  'if git ls-files --error-unmatch -- "$2" >/dev/null 2>&1; then',
  '  git update-index --skip-worktree -- "$2"',
  'fi',
].join('\n');

/**
 * Removes the checkout of branch `$2` from repository `$1` — the one in `$4`, or the worktree on
 * that branch when `$4` is empty —, the branch, and the ref `$3` that kept its base. Prints the
 * directory it removed, if any.
 */
export const REMOVE = [
  '[ -f "$1/HEAD" ] || exit 0',
  'dir=$4',
  'if [ -z "$dir" ]; then',
  '  dir=$(git -C "$1" worktree list --porcelain |',
  '    awk -v b="branch refs/heads/$2" \'/^worktree /{w=substr($0,10)} $0==b{print w; exit}\')',
  'fi',
  'if [ -n "$dir" ]; then',
  '  git -C "$1" worktree remove --force --force "$dir" 2>/dev/null || rm -rf -- "$dir"',
  'fi',
  'git -C "$1" worktree prune',
  'git -C "$1" update-ref -d "refs/heads/$2" 2>/dev/null || true',
  'git -C "$1" update-ref -d "$3" 2>/dev/null || true',
  'printf "%s" "$dir"',
].join('\n');

/** Removes the file `$1`. */
export const REMOVE_FILE = 'rm -f -- "$1"';

/** Removes the directory `$1` and what it holds. */
export const REMOVE_DIRECTORY = 'rm -rf -- "$1"';
