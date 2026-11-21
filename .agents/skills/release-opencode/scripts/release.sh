#!/usr/bin/env bash
# Builds this checkout's opencode and extensions into release folders and puts them live. See ../SKILL.md.
#
#   release.sh build                                 build opencode and extensions, check them; prints the name
#   release.sh use <name> [<extensions-name>]        switch to built releases (restarts)
#   release.sh extensions                            build extensions, switch them live (no restart)
#   release.sh use-extensions <extensions-name>      switch to an existing extensions release (no restart)
#   release.sh list                                  show what is live and what is stored
#   release.sh api <opencode api args...>            call the live OpenChamber server's API (never starts a service)
set -euo pipefail

REPO=$(git -C "$(dirname "$(realpath "$0")")" rev-parse --show-toplevel)
RELEASES=$HOME/.local/share/opencode-releases
BINARIES=$RELEASES/opencode
EXTENSIONS=$RELEASES/extensions
PLUGINS=$HOME/.config/opencode/plugins
SERVICE=openchamber.service
CHECK_PORT=46299
SERVER_ENV=$HOME/.config/openchamber/opencode-server.env
export PATH=$HOME/.local/share/bun/1.4.4/bin:$PATH

die() {
  echo "release: $*" >&2
  exit 1
}

release_name() {
  echo "$(date -u +%Y%m%d%H%M%S)-$(git -C "$REPO" rev-parse --short=12 HEAD)"
}

live_extensions() {
  if [ -f "$PLUGINS/.directory-name" ]; then cat "$PLUGINS/.directory-name"; fi
}

build_opencode() {
  local out=$BINARIES/$1
  [ -e "$out" ] && die "$out already exists"
  local version tmp
  version=$(cd "$REPO/packages/cli" && bun -e 'console.log(require("./package.json").version)')
  tmp=$(mktemp -d)
  (cd "$REPO" && bun install)
  (cd "$REPO/packages/cli" && OPENCODE_TARGET=linux-x64-baseline OPENCODE_CHANNEL=local \
    OPENCODE_VERSION="$version+grant.${1%%-*}" bun run script/build.ts --outdir="$tmp")
  rm -rf "$out.tmp"
  mkdir -p "$out.tmp/bin"
  install -m 0500 "$tmp/cli-linux-x64-baseline/bin/opencode" "$out.tmp/bin/opencode"
  mv "$out.tmp" "$out"
  rm -rf "$tmp"
}

# Each packages/plugins/local-*/index.ts becomes one <folder>.js. effect and @opencode/plugin stay external:
# opencode provides its own copies to plugins and refuses bundled ones.
build_extensions() {
  local out=$EXTENSIONS/$1 dir
  [ -e "$out" ] && die "$out already exists"
  [ "$(live_extensions)" = "$1" ] && die "$1 is already live"
  rm -rf "$out.tmp"
  mkdir -p "$out.tmp"
  for dir in "$REPO"/packages/plugins/local-*/; do
    [ -d "$dir" ] || continue
    [ -f "$dir/index.ts" ] || die "$dir has no index.ts"
    bun build "$dir/index.ts" --target=bun --format=esm --outfile="$out.tmp/$(basename "$dir").js" \
      --external effect --external 'effect/*' --external @opencode/plugin --external '@opencode/plugin/*'
  done
  echo "$1" >"$out.tmp/.directory-name"
  mv "$out.tmp" "$out"
}

check_opencode() {
  local bin=$BINARIES/$1/bin/opencode log pid code=000
  "$bin" --version
  if ss -Hltn "sport = :$CHECK_PORT" | grep -q .; then die "port $CHECK_PORT is in use"; fi
  log=$(mktemp)
  "$bin" serve --hostname 127.0.0.1 --port "$CHECK_PORT" >"$log" 2>&1 &
  pid=$!
  for _ in $(seq 300); do
    code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$CHECK_PORT/" || true)
    [ "$code" = 200 ] && break
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.1
  done
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  if [ "$code" != 200 ]; then
    cat "$log" >&2
    rm -f "$log"
    die "serve check failed (HTTP $code)"
  fi
  rm -f "$log"
  echo "serve check passed"
}

# Two renames back to back: opencode reloads once, so no extension is ever missing. The live folder's
# .directory-name says where to put it back.
use_extensions() {
  local new=$EXTENSIONS/$1 old
  old=$(live_extensions)
  if [ "$old" = "$1" ]; then
    echo "extensions $1 already live"
    return
  fi
  [ -d "$new" ] || die "no extensions release $1"
  if [ -e "$PLUGINS.new" ] || [ -e "$PLUGINS.old" ]; then die "$PLUGINS.new or $PLUGINS.old exists; an earlier release stopped part-way"; fi
  if [ ! -e "$PLUGINS" ]; then
    mkdir -p "$(dirname "$PLUGINS")"
    mv "$new" "$PLUGINS"
    echo "extensions $1 live"
    return
  fi
  [ -n "$old" ] || die "$PLUGINS has no .directory-name"
  [ -e "$EXTENSIONS/$old" ] && die "$EXTENSIONS/$old already exists"
  mv "$new" "$PLUGINS.new"
  mv "$PLUGINS" "$PLUGINS.old" && mv "$PLUGINS.new" "$PLUGINS"
  mv "$PLUGINS.old" "$EXTENSIONS/$old"
  echo "extensions $1 live (was $old)"
}

# Stopping the service kills everything in its cgroup, including a shell an agent runs this from, so the switch
# runs in its own transient unit.
use() {
  [ -x "$BINARIES/$1/bin/opencode" ] || die "no opencode release $1"
  [ -d "$EXTENSIONS/$2" ] || [ "$(live_extensions)" = "$2" ] || die "no extensions release $2"
  local unit
  unit=opencode-release-$(date -u +%Y%m%d%H%M%S)
  systemd-run --user --collect --quiet --unit="$unit" "$(realpath "$0")" _switch "$1" "$2"
  echo "switching in $unit; follow with: journalctl --user -u $unit"
}

switch() {
  trap 'systemctl --user start "$SERVICE"' EXIT
  systemctl --user stop "$SERVICE"
  ln -sfn "$1" "$BINARIES/current.new"
  mv -T "$BINARIES/current.new" "$BINARIES/current"
  echo "opencode $1 current"
  use_extensions "$2"
}

# OpenChamber's opencode is a plain `serve` child of the service, not the CLI's registered background service, so a
# bare `opencode api` would start a second server. --server pins the CLI to the live one and never starts anything.
live_url() {
  local main pid port
  main=$(systemctl --user show -p MainPID --value "$SERVICE")
  [ "${main:-0}" != 0 ] || die "$SERVICE is not running"
  pid=$(pgrep -P "$main" -f 'opencode serve' | head -1) || die "no opencode serve under $SERVICE"
  port=$(tr '\0' ' ' </proc/"$pid"/cmdline | grep -oP -- '--port \K[0-9]+') || die "cannot read the port of PID $pid"
  echo "http://127.0.0.1:$port"
}

api() {
  local password
  password=$(sed -n 's/^OPENCODE_PASSWORD=//p' "$SERVER_ENV" 2>/dev/null) || true
  [ -n "$password" ] || die "cannot read the password from $SERVER_ENV"
  OPENCODE_PASSWORD=$password exec "$BINARIES/current/bin/opencode" --server "$(live_url)" api "$@"
}

list() {
  echo "opencode current: $(readlink "$BINARIES/current" 2>/dev/null || echo none)"
  echo "extensions live:  $(live_extensions || true)"
  echo "opencode releases:"
  ls -1 "$BINARIES" 2>/dev/null | grep -v '^current$' | sed 's/^/  /' || true
  echo "stored extensions releases:"
  ls -1 "$EXTENSIONS" 2>/dev/null | sed 's/^/  /' || true
}

case "${1:-}" in
  build)
    name=$(release_name)
    build_opencode "$name"
    build_extensions "$name"
    check_opencode "$name"
    echo "built $name; switch with: release.sh use $name"
    ;;
  extensions)
    name=$(release_name)
    build_extensions "$name"
    use_extensions "$name"
    ;;
  use) use "${2:?release name}" "${3:-$2}" ;;
  use-extensions) use_extensions "${2:?extensions release name}" ;;
  _switch) switch "$2" "$3" ;;
  list) list ;;
  api) shift; api "$@" ;;
  *) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2 ;;
esac
