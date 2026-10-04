#!/usr/bin/env bash
# nekcode installer and updater for Linux and macOS. Running it again updates an existing install.
#
#   curl -fsSL https://raw.githubusercontent.com/deepdarkpaw/nekcode/nek/scripts/install.sh | bash
#
# Options (environment variables):
#   NEK_INSTALL_DIR  source checkout        (default: ~/.local/share/nekcode)
#   NEK_BIN_DIR      where `nek` is placed  (default: ~/.local/bin)
#   NEK_REPO_URL     git repository         (default: https://github.com/deepdarkpaw/nekcode.git)
#   NEK_BRANCH       branch to track        (default: nek)
#   NEK_SKIP_TOOLS=1 skip fd / rg / ast-grep setup
set -euo pipefail

REPO_URL="${NEK_REPO_URL:-https://github.com/deepdarkpaw/nekcode.git}"
BRANCH="${NEK_BRANCH:-nek}"
INSTALL_DIR="${NEK_INSTALL_DIR:-$HOME/.local/share/nekcode}"
BIN_DIR="${NEK_BIN_DIR:-$HOME/.local/bin}"
MIN_NODE="22.19.0"
MODEL_DATA_DIR="packages/ai/src/providers/data"
RESOLVER="packages/coding-agent/src/experimental/source-resolver.ts"

step() { printf '\n==> %s\n' "$*"; }
fail() {
	printf 'error: %s\n' "$*" >&2
	exit 1
}

require_command() {
	command -v "$1" > /dev/null 2>&1 || fail "$1 is required. $2"
}

check_prerequisites() {
	step "Checking prerequisites"
	require_command git "Install git with your package manager."
	require_command node "Install Node.js $MIN_NODE or newer: https://nodejs.org/"
	require_command npm "npm ships with Node.js: https://nodejs.org/"
	local version
	version="$(node -p 'process.versions.node')"
	node -e '
		const [have, need] = process.argv.slice(1).map((v) => v.split(".").map(Number));
		const ok = have[0] !== need[0] ? have[0] > need[0] : have[1] !== need[1] ? have[1] > need[1] : have[2] >= need[2];
		process.exit(ok ? 0 : 1);
	' "$version" "$MIN_NODE" || fail "Node.js $MIN_NODE or newer is required (found $version)."
	echo "git $(git --version | cut -d' ' -f3), node $version, npm $(npm --version)"
}

# Clone on first install; fast-forward on update. Never touches local edits.
sync_source() {
	if [ -d "$INSTALL_DIR/.git" ]; then
		step "Updating $INSTALL_DIR"
		[ -z "$(git -C "$INSTALL_DIR" status --porcelain --untracked-files=no)" ] ||
			fail "$INSTALL_DIR has local changes. Commit or discard them, then run the installer again."
		git -C "$INSTALL_DIR" fetch --depth 1 origin "$BRANCH"
		git -C "$INSTALL_DIR" checkout -q -B "$BRANCH" FETCH_HEAD
	elif [ -e "$INSTALL_DIR" ] && [ -n "$(ls -A "$INSTALL_DIR")" ]; then
		fail "$INSTALL_DIR exists and is not a git checkout. Remove it or set NEK_INSTALL_DIR."
	else
		step "Cloning $REPO_URL ($BRANCH) into $INSTALL_DIR"
		mkdir -p "$(dirname "$INSTALL_DIR")"
		git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
	fi
	echo "at $(git -C "$INSTALL_DIR" log -1 --format='%h %s')"
}

# npm ci only when the lockfile changed since the last successful install.
install_dependencies() {
	local stamp="$INSTALL_DIR/node_modules/.nek-lock" lock
	lock="$(git -C "$INSTALL_DIR" rev-parse HEAD:package-lock.json)"
	if [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$lock" ]; then
		step "Dependencies are up to date"
		return
	fi
	step "Installing dependencies (npm ci)"
	(cd "$INSTALL_DIR" && npm ci --ignore-scripts --no-audit --no-fund)
	echo "$lock" > "$stamp"
}

# The built-in model catalog is generated, not committed. Refresh it on every install or update.
hydrate_model_data() {
	step "Generating the built-in model catalog"
	local output
	if ! output="$(cd "$INSTALL_DIR" && npm run --silent hydrate:model-data 2>&1)"; then
		printf '%s\n' "$output" >&2
		fail "model catalog generation failed (it downloads model metadata; check the network and run again)"
	fi
	[ -d "$INSTALL_DIR/$MODEL_DATA_DIR" ] || fail "model catalog was not generated in $MODEL_DATA_DIR"
	echo "done"
}

write_launcher() {
	step "Installing the nek command into $BIN_DIR"
	mkdir -p "$BIN_DIR"
	# Git Bash on Windows: node needs a Windows path, and --import needs a file:// URL for drive letters.
	local root="$INSTALL_DIR" resolver="$INSTALL_DIR/$RESOLVER"
	if command -v cygpath > /dev/null 2>&1; then
		root="$(cygpath -m "$INSTALL_DIR")"
		resolver="file:///$root/$RESOLVER"
	fi
	cat > "$BIN_DIR/nek" << EOF
#!/usr/bin/env bash
# nek launcher written by scripts/install.sh: runs nekcode from source in $root.
exec node --import "$resolver" "$root/packages/coding-agent/src/cli.ts" "\$@"
EOF
	chmod +x "$BIN_DIR/nek"
}

setup_tools() {
	if [ "${NEK_SKIP_TOOLS:-}" = "1" ]; then
		step "Skipping fd / rg / ast-grep setup (NEK_SKIP_TOOLS=1)"
		return
	fi
	step "Setting up fd, rg, ast-grep"
	if ! (cd "$INSTALL_DIR" && node --import "./$RESOLVER" scripts/setup-tools.ts); then
		echo "warning: some search tools are unavailable (see above). nek still runs; the listed features fail until they are installed."
	fi
}

finish() {
	step "Done: $("$BIN_DIR/nek" --version)"
	case ":$PATH:" in
		*":$BIN_DIR:"*) echo "Run 'nek' in any project directory." ;;
		*)
			echo "$BIN_DIR is not on PATH. Add this line to ~/.bashrc or ~/.zshrc, then open a new terminal:"
			echo "  export PATH=\"$BIN_DIR:\$PATH\""
			;;
	esac
	echo "Update later by running this installer again."
}

check_prerequisites
sync_source
install_dependencies
hydrate_model_data
write_launcher
setup_tools
finish
