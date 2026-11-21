---
name: release-opencode
description: Use when the user wants to release, update, rebuild, redeploy, roll back or restart the opencode that runs on this machine behind OpenChamber (openchamber.service), or its personal extensions in packages/plugins/local-*. Covers merging an upstream release, full releases (build, then a restarting switch), extensions-only releases (no restart), rollback, and getting a turn back after the restart.
---

# Release opencode

This checkout (`main`) is a personal fork that tracks upstream release tags, not `dev`. The running opencode is a binary built from it, started by the user systemd unit `openchamber.service`. That unit also runs the session you are in, so a restart ends your turn.

A release is a folder of built files named `<yyyymmddhhmmss>-<12-char HEAD sha>` (UTC). It is built from the working tree as it is, uncommitted changes included. There is no source snapshot: to keep the source of a release, commit first.

## Layout

```text
~/.local/share/opencode-releases/
  opencode/<name>/bin/opencode
  opencode/current -> <name>                 the live binary
  extensions/<name>/                         every extensions release except the live one
~/.config/opencode/plugins/                  the live extensions release (a real folder, not a link)
  .directory-name                            its release name
  local-<name>.js                            one bundle per packages/plugins/local-<name>/
```

`openchamber.service` (`OPENCODE_BINARY=`), `~/agents/sysadmin/bin/opencode-source` and `~/agents/sysadmin/bin/openchamber-source` all point at `opencode/current/bin/opencode`, so a release never edits them.

## Extensions

Each personal extension is a folder `packages/plugins/local-<name>/` with an `index.ts` server entry (see `packages/plugins/figma` for the package layout). The workspace already includes `packages/plugins/*`. Bundling makes `index.ts` into one `local-<name>.js`, with `effect` and `@opencode/plugin` left as imports: opencode provides its own copies to plugins and refuses bundled ones. Only the server part is released; TUI and GUI parts are not bundled.

## Commands

All from `.agents/skills/release-opencode/scripts/release.sh`:

| Command | What it does | Restart |
|---|---|---|
| `release.sh build` | Builds opencode and extensions, runs the checks, prints the release name | No |
| `release.sh extensions` | Builds extensions and switches them live | No |
| `release.sh use <name> [<extensions-name>]` | Switches opencode and extensions to built releases; the extensions name defaults to `<name>` | Yes |
| `release.sh use-extensions <extensions-name>` | Switches to an existing extensions release (rollback) | No |
| `release.sh list` | Shows what is live and what is stored | No |
| `release.sh api <args>` | `opencode api <args>` against the live OpenChamber server, e.g. `release.sh api get /api/plugin` | No |

## Checking the live server

OpenChamber launches opencode on a fixed port with a fixed password, both in `~/.config/openchamber/opencode-server.env` (mode 0600; never print the password). `openchamber.service` loads it through the drop-in `openchamber.service.d/opencode-server.conf`. `opencode` on the PATH (`~/.local/bin/opencode` → `~/agents/sysadmin/bin/opencode-source`) reads that file and adds `--server http://127.0.0.1:<port>`, so terminal and session-shell `opencode` commands, the TUI included, talk to OpenChamber's server and never start a background service. When OpenChamber is down they fail to connect; `opencode --standalone` runs a private server instead.

The wrapper passes through unchanged: calls that already have `--server` or `--standalone`, and the commands that reject `--server` (`serve`, `service`, `upgrade`/`update`, `uninstall`, `acp`, `pair`). Of those, `acp` and `pair` still use the CLI's background service and would start one, so don't run them here. `opencode service status` always says `stopped`: OpenChamber's server is a plain `serve` child, not that service.

- Check the live server with `release.sh api …` (or plain `opencode api …`, which the wrapper now routes the same way). `release.sh api` finds the port from the running `opencode serve` under `openchamber.service`, so it also confirms you reach that process.
- Never start an opencode server on the fixed port. If anything listens there when OpenChamber starts, OpenChamber attaches to it as an external opencode and its plugin (the `openchamber_*` tools, session titles) is not loaded.
- Before this setup, a bare `opencode api` started a second server and reported on it instead (2026-11-20). If you see a `serve --service` process, stop it with the real binary: `~/.local/share/opencode-releases/opencode/current/bin/opencode service stop`.
- Right after a switch, plugins load asynchronously, so an empty list may only mean they haven't loaded yet: retry for a few seconds before concluding anything.

## Full release

Always two separate calls, so a failure shows up before anything is stopped:

1. **Build and stage.** Run `release.sh build` (about a minute; run it in the background if you like and wait for its notification). It touches nothing live. If it fails, fix the cause and build again; production is unaffected. Note the printed name.
2. **Switch.** Only after a successful build: schedule the wake-up (below), then run `release.sh use <name>`. The switch itself takes a few seconds.

## Merging an upstream release

1. **Find the release.** `git ls-remote --tags --refs upstream 'v2.*' | sort -V`. `upstream` is `anomalyco/opencode` (a partial clone, so read tags this way). The GitHub "Latest" badge may point at the old v1 line; use the newest v2 tag.
2. **Merge.** `git fetch upstream tag vX.Y.Z --no-tags`, then `git merge --no-edit vX.Y.Z`. Expect conflicts only in `package.json` version bumps, `bun.lock` and `CHANGELOG.md`. Resolve every file to upstream: for each path in `git diff --cached --name-only vX.Y.Z` that is not a personal file (`personalchanges.md`, `.agents/`, `packages/plugins/local-*`), `git checkout vX.Y.Z -- <path>`, or `git rm` it if the tag doesn't have it (`git checkout --theirs` fails on files upstream deleted). Verify `git diff --stat vX.Y.Z HEAD` shows only personal files, then commit.
3. **Fix extensions** if the plugin API changed, and commit.
4. **Release** as in Full release above.

`personalchanges.md` records changes to upstream files only. Personal files (`personalchanges.md`, `.agents/`, `packages/plugins/local-*`), merges resolved to upstream, and releases need no entry.

## Getting a turn back after a restart

`release.sh use` restarts OpenChamber, which kills your turn along with any background shell or subagent, so their notifications never arrive. OpenChamber's scheduled tasks survive the restart and can target this session. Before running either command:

1. Read the session ID from `$OPENCODE_SESSION_ID` and the time with `date`.
2. Inside a Code Mode `execute` script, create a one-time task due about 2 minutes after you run `use`. The build is already done, so only the stop and start need covering (about 2 seconds on 2026-11-20):
   ```js
   await tools.openchamber_schedule({ action: "schedule.create", parameters: {
     name: "Post-restart wake-up",
     targetSessionId: "<$OPENCODE_SESSION_ID>",
     once: "YYYY-MM-DD", time: "HH:MM", timezone: "America/New_York",
     prompt: "Restart done. Run release.sh list, check openchamber.service and the running opencode version, then report.",
   }})
   ```
3. Run the command. Your tool call may be reported as interrupted; that is expected.
4. The prompt arrives as a new turn. Confirm `systemctl --user is-active openchamber.service`, that the running `opencode serve` process uses `opencode-releases/opencode/current/bin/opencode`, and read the transient unit's journal. Delete the task with `schedule.delete` (once-tasks disable themselves but stay listed).

Tested 2026-11-20: the task fired into the same session less than a second after its due time. Not tested: whether a task that comes due while OpenChamber is still down runs late or is skipped, so keep the 2-minute margin rather than cutting it closer.

If the new opencode does not start, OpenChamber is down and the wake-up cannot run. The user rolls back from a terminal: `release.sh use <previous-opencode-name> <previous-extensions-name>` (names from `release.sh list`).

## Older builds

Builds from before this layout stay in `~/.local/share/openchamber-stack/builds/opencode/<upstream-commit>/` (v2.2.5 and earlier). The v2.3.2 build was copied into `opencode-releases/opencode/` as `20261120161455-c0ad18b402eb`. The files repointed to `current` were backed up as `*.bak-pre-releases`.
