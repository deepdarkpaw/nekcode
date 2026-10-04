#!/usr/bin/env bash
set -euo pipefail

# Developer wrapper that runs nek directly from this checkout's source.
# Pass --stable to use the next nek executable on PATH.
#
# From the repository root, install with:
#   mkdir -p "$HOME/.local/bin"
#   ln -s "$PWD/scripts/auto-nek.sh" "$HOME/.local/bin/nek"
#
# ~/.local/bin must appear before the stable nek installation on PATH.

# Resolve this script through symlinks so repo_dir points at the development
# checkout rather than the directory containing the `nek` symlink.
script_path="${BASH_SOURCE[0]}"
while [[ -L "$script_path" ]]; do
	script_dir="$(cd -P "$(dirname "$script_path")" && pwd)"
	link_target="$(readlink "$script_path")"
	if [[ "$link_target" == /* ]]; then
		script_path="$link_target"
	else
		script_path="$script_dir/$link_target"
	fi
done
script_dir="$(cd -P "$(dirname "$script_path")" && pwd)"
repo_dir="$(cd "$script_dir/.." && pwd)"

find_stable_nek() {
	local path_entry candidate candidate_dir
	local -a path_entries
	IFS=: read -r -a path_entries <<< "${PATH:-}"
	for path_entry in "${path_entries[@]}"; do
		[[ -n "$path_entry" ]] || path_entry=.
		candidate="$path_entry/nek"
		[[ -x "$candidate" && ! -d "$candidate" ]] || continue
		[[ "$candidate" -ef "$script_path" ]] && continue
		candidate_dir="$(cd -P "$(dirname "$candidate")" && pwd)" || continue
		printf '%s/%s\n' "$candidate_dir" "$(basename "$candidate")"
		return 0
	done
	return 1
}

use_stable=false
args=()
for arg in "$@"; do
	if [[ "$arg" == "--stable" ]]; then
		use_stable=true
	else
		args+=("$arg")
	fi
done

if [[ "$use_stable" == true ]]; then
	if ! stable_nek="$(find_stable_nek)"; then
		echo "error: could not find a stable nek executable after the auto-nek wrapper on PATH" >&2
		exit 1
	fi
	exec "$stable_nek" ${args[@]+"${args[@]}"}
fi

resolver="$repo_dir/packages/coding-agent/src/experimental/source-resolver.ts"
if command -v cygpath > /dev/null 2>&1; then
	repo_dir="$(cygpath -m "$repo_dir")"
	resolver="file:///$repo_dir/packages/coding-agent/src/experimental/source-resolver.ts"
fi
exec node --import "$resolver" "$repo_dir/packages/coding-agent/src/cli.ts" ${args[@]+"${args[@]}"}
