#!/usr/bin/env bash
# Source installer for Linux, macOS, and Git Bash. Options: NEK_INSTALL_DIR,
# NEK_BIN_DIR, NEK_REPO_URL, NEK_BRANCH, NEK_CHANNEL, NEK_SKIP_TOOLS, NEK_INSTALL_BUN.
set -euo pipefail

REPO_URL="${NEK_REPO_URL:-https://github.com/deepdarkpaw/nekcode.git}"
INSTALL_DIR="${NEK_INSTALL_DIR:-$HOME/.local/share/nekcode}"
STATE_FILE="$INSTALL_DIR/.nek-install-state.json"
MIN_NODE="22.19.0"
RESOLVER="packages/coding-agent/src/experimental/source-resolver.ts"

step() { printf '\n==> %s\n' "$*"; }
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }
require_command() { command -v "$1" >/dev/null 2>&1 || fail "$1 is required. $2"; }

check_prerequisites() {
	step "Checking prerequisites"
	require_command git "Install git with your package manager."
	require_command node "Install Node.js $MIN_NODE or newer: https://nodejs.org/"
	require_command npm "npm ships with Node.js."
	node -e 'const v=process.versions.node.split(".").map(Number);process.exit(v[0]>22||(v[0]===22&&v[1]>=19)?0:1)' ||
		fail "Node.js $MIN_NODE or newer is required."
}

read_state() {
	local saved_bin="" saved_channel="" saved_branch="" saved_skip="0" saved_bun="0"
	if [ -f "$STATE_FILE" ]; then
		saved_bin="$(node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(s.binDir||"")' "$STATE_FILE")"
		saved_channel="$(node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(s.channel||"")' "$STATE_FILE")"
		saved_branch="$(node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(s.branch||"")' "$STATE_FILE")"
		saved_skip="$(node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(s.skipTools ? "1" : "0")' "$STATE_FILE")"
		saved_bun="$(node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(s.installBun ? "1" : "0")' "$STATE_FILE")"
	fi
	BIN_DIR="${NEK_BIN_DIR:-${saved_bin:-$HOME/.local/bin}}"
	CHANNEL="${NEK_CHANNEL:-${saved_channel:-stable}}"
	BRANCH="${NEK_BRANCH:-${saved_branch:-nek}}"
	SKIP_TOOLS="${NEK_SKIP_TOOLS:-$saved_skip}"
	INSTALL_BUN="${NEK_INSTALL_BUN:-$saved_bun}"
	INSTALL_DIR="$(node -e 'process.stdout.write(require("path").resolve(process.argv[1]))' "$INSTALL_DIR")"
	BIN_DIR="$(node -e 'process.stdout.write(require("path").resolve(process.argv[1]))' "$BIN_DIR")"
	STATE_FILE="$INSTALL_DIR/.nek-install-state.json"
	case "$CHANNEL" in stable|dev) ;; *) fail "NEK_CHANNEL must be stable or dev." ;; esac
}

sync_source() {
	local remote="$REPO_URL" target="$BRANCH" fresh=0 release_head="" current_branch=""
	if [ -e "$INSTALL_DIR/.git" ]; then
		step "Updating $INSTALL_DIR ($CHANNEL)"
		[ -z "$(git -C "$INSTALL_DIR" status --porcelain --untracked-files=no)" ] ||
			fail "$INSTALL_DIR has local changes. Commit or discard them before updating."
		remote="$(git -C "$INSTALL_DIR" remote get-url origin)"
	elif [ -e "$INSTALL_DIR" ] && [ -n "$(ls -A "$INSTALL_DIR")" ]; then
		fail "$INSTALL_DIR exists and is not a git checkout. Set NEK_INSTALL_DIR to another path."
	else
		fresh=1
	fi
	if [ "$CHANNEL" = stable ]; then
		target="$(git ls-remote --tags --refs "$remote" 'refs/tags/nek-v*' | node -e '
let text="";
process.stdin.on("data", c => text += c);
process.stdin.on("end", () => {
 const versions = text.split(/\r?\n/).map(line => line.trim().split(/\s+/).at(-1)?.replace("refs/tags/", ""))
  .map(tag => ({ tag, match: /^nek-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(tag || "") }))
  .filter(v => v.match && v.match.slice(1,4).every(n => Number.isSafeInteger(Number(n))) && (!v.match[4] || v.match[4].split(".").every(p => p && (!/^\d+$/.test(p) || !/^0\d/.test(p)))))
  .map(v => ({ tag: v.tag, core: v.match.slice(1,4).map(Number), pre: v.match[4]?.split(".") || [] }));
 const compare = (a,b) => {
  for (let i=0;i<3;i++) if (a.core[i]!==b.core[i]) return a.core[i]-b.core[i];
  if (!a.pre.length || !b.pre.length) return !a.pre.length ? (!b.pre.length ? 0 : 1) : -1;
  for (let i=0;i<Math.max(a.pre.length,b.pre.length);i++) {
   const x=a.pre[i],y=b.pre[i]; if(x===y)continue; if(x===undefined)return -1;if(y===undefined)return 1;
   const xn=/^\d+$/.test(x),yn=/^\d+$/.test(y);if(xn&&yn)return BigInt(x)<BigInt(y)?-1:1;if(xn!==yn)return xn?-1:1;return x<y?-1:1;
  } return 0;
 };
 versions.sort((a,b)=>compare(b,a)); process.stdout.write(versions[0]?.tag || "");
});
')"
		[ -n "$target" ] || fail "No nek-v* stable release tags found. Use NEK_CHANNEL=dev to track $BRANCH."
	fi
	if [ "$fresh" = 1 ]; then
		step "Cloning $remote ($target) into $INSTALL_DIR"
		mkdir -p "$(dirname "$INSTALL_DIR")"
		git clone --no-checkout --branch "$target" "$remote" "$INSTALL_DIR"
	else
		if [ "$(git -C "$INSTALL_DIR" rev-parse --is-shallow-repository)" = true ]; then
			git -C "$INSTALL_DIR" fetch --unshallow origin
		fi
		git -C "$INSTALL_DIR" fetch origin "$target"
		current_branch="$(git -C "$INSTALL_DIR" symbolic-ref --quiet --short HEAD || true)"
		if [ -z "$current_branch" ]; then
			release_head="$(git -C "$INSTALL_DIR" tag --points-at HEAD --list 'nek-v*' | grep -E '^nek-v[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$' || true)"
		fi
		if [ -z "$release_head" ] && ! git -C "$INSTALL_DIR" merge-base --is-ancestor HEAD FETCH_HEAD; then
			fail "Update refused: HEAD has local commits or diverges from $target. No local branch was moved."
		fi
	fi
	local target_ref=FETCH_HEAD
	[ "$fresh" = 0 ] || target_ref="$target"
	if [ "$CHANNEL" = stable ]; then
		git -C "$INSTALL_DIR" checkout -q --detach "$target_ref"
	elif git -C "$INSTALL_DIR" show-ref --verify --quiet "refs/heads/$BRANCH"; then
		git -C "$INSTALL_DIR" merge-base --is-ancestor "$BRANCH" "$target_ref" ||
			fail "Update refused: local branch $BRANCH has local commits."
		git -C "$INSTALL_DIR" checkout -q "$BRANCH"
		git -C "$INSTALL_DIR" merge --ff-only "$target_ref"
	else
		git -C "$INSTALL_DIR" checkout -q -b "$BRANCH" "$target_ref"
	fi
	if [ "$CHANNEL" = dev ]; then
		git -C "$INSTALL_DIR" branch --set-upstream-to="origin/$BRANCH" "$BRANCH"
	fi
	echo "at $(git -C "$INSTALL_DIR" log -1 --format='%h %s')"
}

install_dependencies() {
	local stamp="$INSTALL_DIR/node_modules/.nek-lock" lock saved=""
	lock="$(git -C "$INSTALL_DIR" rev-parse HEAD:package-lock.json)"
	[ ! -f "$stamp" ] || read -r saved < "$stamp" || true
	if [ "$saved" = "$lock" ]; then step "Dependencies are up to date"; return; fi
	step "Installing dependencies (npm ci)"
	(cd "$INSTALL_DIR" && npm ci --ignore-scripts --no-audit --no-fund)
	printf '%s\n' "$lock" > "$stamp"
}

hydrate_model_data() {
	step "Generating the built-in model catalog"
	local output
	if ! output="$(cd "$INSTALL_DIR" && npm run --silent hydrate:model-data 2>&1)"; then
		printf '%s\n' "$output" >&2
		fail "model catalog generation failed; check the network and run again"
	fi
	[ -d "$INSTALL_DIR/packages/ai/src/providers/data" ] || fail "model catalog was not generated"
}

write_launcher() {
	step "Installing the nek command into $BIN_DIR"
	mkdir -p "$BIN_DIR"
	local root resolver
	root="$(cd "$INSTALL_DIR" && pwd)"
	command -v cygpath >/dev/null 2>&1 && root="$(cygpath -m "$root")"
	resolver="$(node -e 'process.stdout.write(require("url").pathToFileURL(require("path").resolve(process.argv[1])).href)' "$root/$RESOLVER")"
	printf '#!/usr/bin/env bash\nexec node --import %q %q "$@"\n' "$resolver" "$root/packages/coding-agent/src/cli.ts" > "$BIN_DIR/nek"
	chmod +x "$BIN_DIR/nek"
	node -e 'const fs=require("fs");fs.writeFileSync(process.argv[1],JSON.stringify({binDir:process.argv[2],channel:process.argv[3],branch:process.argv[4],skipTools:process.argv[5]==="1",installBun:process.argv[6]==="1"},null,2)+"\n")' "$STATE_FILE" "$BIN_DIR" "$CHANNEL" "$BRANCH" "$SKIP_TOOLS" "$INSTALL_BUN"
}

setup_tools() {
	[ "$SKIP_TOOLS" != 1 ] || return 0
	step "Setting up fd, rg, ast-grep"
	(cd "$INSTALL_DIR" && node --import "./$RESOLVER" scripts/setup-tools.ts) || fail "search tool setup failed; install the listed tools and rerun"
}

install_bun() {
	[ "$INSTALL_BUN" = 1 ] || return 0
	command -v bun >/dev/null 2>&1 && return
	step "Installing Bun for the optional OpenTUI frontend"
	require_command curl "Install curl with your package manager."
	curl -fsSL https://bun.sh/install | bash
}

check_prerequisites
read_state
sync_source
install_dependencies
hydrate_model_data
write_launcher
setup_tools
install_bun
step "Done: $("$BIN_DIR/nek" --version)"
echo "Update later with 'nek update'. Channel: $CHANNEL."
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) echo "Add $BIN_DIR to PATH, then open a new terminal." ;; esac
