# Personal changes

## 2026-10-31: source-only baseline build

This entry records a build, not an application deployment. No upstream code,
manifest, lockfile, or dependency patch was changed. The first ledger commit
attempt stopped before staging because Git had no configured `user.name`.
Main subsequently supplied a verified repo-local identity. No identity was
invented, no global Git setting changed, and the successful build was not repeated.

### Source and toolchain

- Repository: `/home/grant/code/opencode`, personal branch `main`.
- Upstream baseline: tag `v2.2.5`, commit
  `9bbb8ce18c80f099e0e448775f59d965ead40a21`.
- `origin`: `git@github.com:grantwest/opencode-personal.git`.
- `upstream`: `git@github.com:anomalyco/opencode.git`.
- The tree was clean before installation and after the build.
- Bun: `/home/grant/.local/share/bun/1.4.4/bin/bun`, version `1.4.4`.
- Existing Node: `/usr/bin/node`, version `24.22.2`; no system toolchain change.
- Root `bun.lock` SHA-256:
  `637e50b7418819af5bdbb28f705d8ff2ced8695f0f04fd6edb4c627bcb745d63`.
- All tracked lockfiles and `patches/` files retained their pre-build hashes.

### Build recipe

The working directory is the repository root. The private build directory is:

```sh
build_root=/home/grant/.local/state/sysadmin-maintenance/openchamber-source-setup-2026-10-31/opencode-build
```

The build directory and its HOME/cache/tmp/config/data/state children have mode
0700. The launcher uses `umask 077`. Logs and JSON observations have mode 0600.
No launcher environment or credentials are inherited. The exact environment is:

```sh
clean_run() {
  /usr/bin/env -i \
    HOME="$build_root/home" \
    PATH=/home/grant/.local/share/bun/1.4.4/bin:/usr/bin:/bin \
    XDG_CACHE_HOME="$build_root/cache" \
    XDG_CONFIG_HOME="$build_root/config" \
    XDG_DATA_HOME="$build_root/data" \
    XDG_STATE_HOME="$build_root/state" \
    TMPDIR="$build_root/tmp" \
    BUN_INSTALL_CACHE_DIR="$build_root/cache/bun" \
    HUSKY=0 LANG=C.UTF-8 UV_THREADPOOL_SIZE=2 \
    GOMAXPROCS=2 RAYON_NUM_THREADS=2 \
    "$@"
}

clean_run /usr/bin/nice -n 10 \
  /home/grant/.local/share/bun/1.4.4/bin/bun install \
  --frozen-lockfile --concurrent-scripts=1 --network-concurrency=8

clean_run /usr/bin/env \
  OPENCODE_VERSION=2.2.5+grant.1 \
  OPENCODE_CHANNEL=local \
  OPENCODE_TARGET=linux-x64-baseline \
  /usr/bin/nice -n 10 \
  /home/grant/.local/share/bun/1.4.4/bin/bun run \
  --cwd packages/cli build --skip-install
```

The recorded launcher supplied the 3 build variables directly to `env -i`,
which is equivalent to the second command above. It used an exclusive lock,
ran the installation and build serially, and refused a duplicate step record.
It required at least 3 GiB available memory before the build.

Installation succeeded with exit code 0: 1,797 packages, 361.731 seconds.
Bun internally retried registry requests. No failed installation was replayed.
Husky reported `HUSKY=0 skip install`. The root PTY helper permission script ran.
The build succeeded with exit code 0 in 93.951 seconds.

### Artifact and resource observations

- Artifact: `packages/cli/dist/cli-linux-x64-baseline/bin/opencode`.
- Size: 271,423,664 bytes.
- SHA-256:
  `d7f50ef9a273433f367336a050b56bcd4da91d05b8a435bcdbfbe25f5b0dc173`.
- Generated artifact metadata declares version `2.2.5+grant.1` and Linux x64.
- Available memory before the build: 4,902,408 KiB.
- Maximum child resident size reported by `getrusage`: 2,328,452 KiB.
  This is not a sampled combined peak for the entire process tree.
- Available memory after the build: 4,916,452 KiB.
- Host swap use increased during installation/build; the snapshots do not
  attribute all host-wide changes to this build.
- Root filesystem free space after the build: approximately 85 GiB.
- The private build cache/state directory retained approximately 3.0 GiB.

### Limitations and activation gates

- The executable was not run, including `--version`. No application, service,
  authentication flow, model request, or runtime test was started. Nothing was
  pushed or staged outside this ledger.
- The upstream build creates embedded web assets in `packages/app/dist` and
  `packages/cli/.cache`. These paths, CLI `dist`, and root `node_modules` were
  absent before the build. CLI `dist` is generated output, not a live install.
- `--skip-install` avoids the build script's extra non-frozen installation.
  It does not prevent native downloads: Bun downloaded its baseline compiler
  runtime. Native npm dependencies are upstream prebuilt components, not a
  claim that every component was compiled from source or works without AVX2.
- Bun warned that 4 declared patches are inactive: Google, Mistral,
  standard-openapi, and GCP metadata. GCP metadata resolves to `8.1.4`, not the
  patched `8.1.2`. Preserve these warnings; do not silently regenerate the lock.
- The web build reported 12 CSS optimization warnings, ineffective dynamic
  imports, large chunks, plugin timing advice, and a future Vite config-loader
  compatibility warning. These did not fail the build; UI behavior is untested.
- Runtime discovery controls remain unreviewed for activation. XDG namespacing
  alone does not suppress system configuration, home skills, provider credential
  discovery, external plugins/MCP, shared services, or all temporary paths.
  Tool permission rules are not an operating-system sandbox.
- Persistent activation, provider use, and application execution require a
  separate reviewed profile and explicit authorization. This build grants none.

Private evidence is retained under `opencode-build/`: `preflight.json`,
`install.json`, `install.log`, `build.json`, `build.log`, `run-step.py`, and
`completion.json`. These records contain the exact argument vectors and resource
snapshots. Do not put private caches or logs in Git.
