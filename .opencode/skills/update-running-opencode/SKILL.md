---
name: update-running-opencode
description: Use when the user wants to update, rebuild, redeploy or restart the opencode that is running on this machine behind OpenChamber (openchamber.service), for example "merge the latest release and restart", or any time you need to restart opencode/openchamber from inside your own session and get a turn back afterwards.
---

# Update the running opencode

This checkout (`main`) is a personal fork that tracks upstream release tags, not `dev`. The running opencode is a binary built from it and started by the user systemd unit `openchamber.service`. That unit also runs the session you are in, so restarting it ends your turn.

## Layout

- Remotes: `origin` is the personal fork, `upstream` is `anomalyco/opencode` (a partial clone, so read tags with `git ls-remote --tags --refs upstream`).
- `personalchanges.md` is the ledger of every local difference from upstream. Add an entry for each update.
- Builds live at `~/.local/share/openchamber-stack/builds/opencode/<upstream-commit>/bin/opencode`, one directory per upstream commit. Keep the previous one for rollback.
- The binary path appears in three places, which must all be updated together:
  - `~/.config/systemd/user/openchamber.service` (`OPENCODE_BINARY=`)
  - `~/agents/sysadmin/bin/opencode-source`
  - `~/agents/sysadmin/bin/openchamber-source`

## Steps

1. **Find the release.** `git ls-remote --tags --refs upstream 'v2.*' | sort -V`. The GitHub "Latest" badge may point at the old v1 line; use the newest v2 tag.
2. **Merge.** `git fetch upstream tag vX.Y.Z --no-tags`, then `git merge --no-edit vX.Y.Z`. Expect conflicts only in `package.json` version bumps, `bun.lock` and `CHANGELOG.md`. Resolve every file to upstream: for each path in `git diff --cached --name-only vX.Y.Z` other than `personalchanges.md`, `git checkout vX.Y.Z -- <path>`, or `git rm` it if the tag doesn't have it (`git checkout --theirs` fails on files upstream deleted). Verify `git diff --stat vX.Y.Z HEAD` shows only the personal files, then commit.
3. **Build** in the background (a few minutes), with the Bun version from `packageManager`:
   ```bash
   export PATH=$HOME/.local/share/bun/1.4.4/bin:$PATH
   bun install
   cd packages/cli && OPENCODE_TARGET=linux-x64-baseline OPENCODE_CHANNEL=local \
     OPENCODE_VERSION=X.Y.Z+grant.1 bun run script/build.ts --outdir=/tmp/opencode-build
   ```
   Output: `/tmp/opencode-build/cli-linux-x64-baseline/bin/opencode`.
4. **Smoke-test** before touching the service: run `opencode --version`, and start `opencode serve --hostname 127.0.0.1 --port 46299` briefly and check it answers HTTP 200.
5. **Install and repoint.** `install -m 0500` the binary into `builds/opencode/<commit of vX.Y.Z>/bin/`, back up the three files above, and `sed` the old commit hash to the new one in each. Add a `personalchanges.md` entry (version, SHA-256, path) and commit **before** restarting.
6. **Schedule your own wake-up, then restart.** See below.
7. **After the wake-up**, confirm `systemctl --user show openchamber.service -p ActiveState` is `active` and the running `opencode serve` process uses the new path, delete the scheduled task, and report to the user.

## Getting a turn back after the restart

Restarting `openchamber.service` kills your session's turn, along with any background shell command or subagent, so their notifications never arrive. OpenChamber's scheduled tasks are saved to disk and survive the restart, and one can target this very session:

1. Read the session ID from `$OPENCODE_SESSION_ID` and the time with `date`.
2. Inside a Code Mode `execute` script, create a one-time task due a few minutes after you will restart:
   ```js
   await tools.openchamber_schedule({ action: "schedule.create", parameters: {
     name: "Post-restart wake-up",
     targetSessionId: "<$OPENCODE_SESSION_ID>",
     once: "YYYY-MM-DD", time: "HH:MM", timezone: "America/New_York",
     prompt: "Restart done. Verify openchamber.service and the running opencode version, then report.",
   }})
   ```
3. Restart without waiting: `systemctl --user daemon-reload && systemctl --user --no-block restart openchamber.service`. The tool call will be reported as interrupted; that is expected.
4. The prompt arrives in this session as a new turn. Delete the task with `schedule.delete` afterwards (once-tasks disable themselves but stay listed).

Tested 2026-11-20: the task fired into the same session less than a second after its due time. Not tested: whether a task that comes due while OpenChamber is still down runs late or is skipped, so leave a margin of a few minutes.

## Rollback

Restore the three `*.bak-*` files (or `sed` the hash back to the previous build's directory), `systemctl --user daemon-reload`, and restart the same way.
