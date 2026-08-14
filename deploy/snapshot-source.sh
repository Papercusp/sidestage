#!/usr/bin/env bash
set -euo pipefail

repo_arg="${1:-}"
destination_arg="${2:-}"

if [[ -z "$repo_arg" || -z "$destination_arg" ]]; then
  echo "Usage: snapshot-source.sh <repository> <empty-destination>" >&2
  exit 2
fi

repo_root="$(git -C "$repo_arg" rev-parse --show-toplevel)"
mkdir -p "$destination_arg"
destination="$(cd "$destination_arg" && pwd -P)"

case "$destination/" in
  "$repo_root/"*)
    echo "snapshot-source: destination must be outside the repository" >&2
    exit 2
    ;;
esac

if [[ -n "$(find "$destination" -mindepth 1 -print -quit)" ]]; then
  echo "snapshot-source: destination must be empty: $destination" >&2
  exit 2
fi

scratch_dir="$(mktemp -d "${TMPDIR:-/tmp}/sidestage-snapshot-index.XXXXXX")"
snapshot_exclude_file="$scratch_dir/deploy-excludes"
cat >"$snapshot_exclude_file" <<'EOF'
# Test-run state is never application source. Keep it out at every recursive
# repository boundary, including submodules whose own .gitignore predates the
# shared Vitest cache convention.
.vitest-tmp/
EOF
cleanup() {
  rm -rf -- "$scratch_dir"
}
trap cleanup EXIT INT TERM

index_number=0

snapshot_repository() {
  local repository="$1"
  local prefix="$2"
  local index_file index_entry header mode relative_path submodule_prefix export_root status

  index_number=$((index_number + 1))
  index_file="$scratch_dir/index-$index_number"

  GIT_INDEX_FILE="$index_file" git -c core.excludesFile="$snapshot_exclude_file" -C "$repository" read-tree HEAD
  GIT_INDEX_FILE="$index_file" git -c core.excludesFile="$snapshot_exclude_file" -C "$repository" add -A -- .
  # Some shared libraries historically committed Vitest cache entries before
  # the convention was ignored. Remove both tracked and untracked cache state
  # from this temporary export index; the real index and worktree stay intact.
  GIT_INDEX_FILE="$index_file" git -c core.excludesFile="$snapshot_exclude_file" -C "$repository" \
    rm -r -f --cached --ignore-unmatch -- '.vitest-tmp' ':(glob)**/.vitest-tmp/**' >/dev/null

  status="$(
    GIT_INDEX_FILE="$index_file" git -c core.excludesFile="$snapshot_exclude_file" -C "$repository" \
      diff --name-status --ignore-submodules=all
    GIT_INDEX_FILE="$index_file" git -c core.excludesFile="$snapshot_exclude_file" -C "$repository" \
      ls-files --others --exclude-standard
  )"
  if [[ -n "$status" ]]; then
    echo "snapshot-source: working tree changed while the snapshot was being captured:" >&2
    printf '%s\n' "$status" >&2
    exit 3
  fi

  export_root="$destination"
  if [[ -n "$prefix" ]]; then
    export_root="$destination/$prefix"
  fi
  mkdir -p "$export_root"
  GIT_INDEX_FILE="$index_file" git -c core.excludesFile="$snapshot_exclude_file" -C "$repository" \
    checkout-index --all --force --prefix="$export_root/"

  while IFS= read -r -d '' index_entry; do
    header="${index_entry%%$'\t'*}"
    mode="${header%% *}"
    [[ "$mode" == "160000" ]] || continue

    relative_path="${index_entry#*$'\t'}"
    if ! git -C "$repository/$relative_path" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      continue
    fi

    submodule_prefix="${prefix:+$prefix/}$relative_path"
    snapshot_repository "$repository/$relative_path" "$submodule_prefix"
  done < <(
    GIT_INDEX_FILE="$index_file" git -c core.excludesFile="$snapshot_exclude_file" -C "$repository" ls-files --stage -z
  )
}

snapshot_repository "$repo_root" ""
