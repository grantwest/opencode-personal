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

The build directory and its HOME/cache/tmp/config/data/state children have mode 0700. The launcher uses `umask 077`. Logs and JSON observations have mode 0600.
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

## 2026-10-31: private foreground system-config suppression

Main approved this corrected internal scope after independent design review.
The baseline ledger was committed separately as
`bca89abfdb0cd5d3a3976704ed1d6dc9c785f643` after Main supplied the verified
repo-local Git identity. The original successful build was not repeated.

- `packages/cli/src/server-process.ts` now maps
  `OPENCODE_CONFIG_SYSTEM_DISABLE=1` (also `true`, case-insensitive) to
  `config.system=false`, only for default foreground mode. Unset, `false`, and
  `0` leave the option undefined. Service and stdio modes ignore this flag.
  The production option adapter is exported inside the CLI module for focused
  unit coverage; no executable entrypoint is run by those tests.
- `packages/server/src/options.ts` accepts optional boolean `config.system`.
  `packages/server/src/routes.ts` forwards it to Core's existing
  `Config.configured` option. No Protocol, HttpApi, schema/client generation,
  manifest, lockfile, or dependency patch was changed.
- Global app configuration remains enabled. The launcher still requires matching
  private HOME/OPENCODE_TEST_HOME, private TMPDIR before imports, explicit XDG,
  configuration and database paths, and project/Claude-disable flags. These
  controls are not an operating-system sandbox or approval for activation.

Focused validation used Bun 1.4.4, `env -i`, private state under
`opencode-build/config-system-tests/`, and nice priority 10:

```sh
# From packages/cli:
bun test --timeout 30000 --only-failures --rerun-each 10 ./test/server-process-config.test.ts
bun run typecheck

# From packages/server:
bun test --only-failures --rerun-each 10 ./test/config-system-options.test.ts
bun run typecheck
```

The CLI matrix covers 6 flag values across all 3 modes: 180 passes, 0 failures
with repetition. The Server matrix covers unset/false/true through the real
options schema and both route constructors: 60 passes, 0 failures. A call-through
spy captures the actual arguments passed to Core's `Config.configured`; the
layer is not acquired. The tests do not discover configuration, start a server,
open an application database, or execute the application.

Both package typechecks passed. Focused oxlint on all 5 owned TypeScript files
reported 0 warnings and 0 errors. The first formatting check found only the
previous ledger's Markdown formatting; Prettier then formatted that owned file.
No full package test suite or full-repository check was run, because those checks
exceed the reviewed focused, non-server scope. Exact check arguments and private
logs are retained with the test state.

Main must review the committed patch before an accepted rebuild. No rebuild,
application execution, provider authentication, model request, service activation,
or push occurred. The original artifact remains at its original path and hash;
it does not contain this patch. Preserve its original completion record as
historical build evidence, including the identity blocker that was later resolved.

## 2026-10-31: accepted rebuild and private artifact staging

Independent reviewer `review` accepted source commit
`3f70e97e41ae20cb9c0a89b29b661de1008f5de9` for rebuilding. No blocking defect
was found. Main approved the rebuild, private staging, and this ledger update,
not application execution or activation. Main clarified that the unchanged build
can replace the generated web outputs as well as CLI dist. No production source,
test, dependency, manifest, lockfile, or patch changed after review.

### Preservation and build

The original unexecuted `2.2.5+grant.1` artifact was copied exclusively to:

```text
/home/grant/.local/state/sysadmin-maintenance/openchamber-source-setup-2026-10-31/opencode-build/accepted-grant-2/baseline/bin/opencode
```

Its SHA-256 was verified before and after the rebuild:
`d7f50ef9a273433f367336a050b56bcd4da91d05b8a435bcdbfbe25f5b0dc173`.
Its size remains 271,423,664 bytes. The archive and its adjacent `manifest.json`
were not overwritten. This archive replaces the earlier ledger's original-path
preservation assumption: the generated CLI dist path now contains the new build.

The accepted source was clean and exact before rebuilding. The build reused the
verified Bun 1.4.4 binary, existing successful dependency installation, and the
same private `env -i` environment from the baseline recipe. Only the build version
changed to `2.2.5+grant.2`; channel stayed `local`, target stayed
`linux-x64-baseline`, priority stayed nice 10, and `--skip-install` stayed enabled.
The command from the repository root was:

```sh
# Use the baseline clean environment above, with these build variables:
clean_run /usr/bin/env \
  OPENCODE_VERSION=2.2.5+grant.2 \
  OPENCODE_CHANNEL=local \
  OPENCODE_TARGET=linux-x64-baseline \
  /usr/bin/nice -n 10 \
  /home/grant/.local/share/bun/1.4.4/bin/bun run \
  --cwd packages/cli build --skip-install
```

Bun SHA-256 remained
`10702245766b225e70bbf6235fd6b47214fd94b4760d00ffaed8ab0df57ac235`.
Node remained `24.22.2`. Exact tool paths, hashes, environment, command arguments,
and resource snapshots are in the staged manifest and private build record.

Available memory before the build was 4,971,532 KiB, above the 3 GiB minimum.
The build passed with exit code 0 in 92.112 seconds. Maximum child resident size
was 2,374,268 KiB, not an aggregate process-tree peak. The source stayed clean.
Protected lockfile and patch hashes remained unchanged. The existing nonfatal
CSS, dynamic-import, chunk-size, plugin timing, and Vite loader warnings remain.

The build replaced only these approved generated outputs, plus ordinary build
caches inside the checkout or private build-state directory:

- `packages/app/dist`
- `packages/cli/dist`
- `packages/cli/.cache/bun-app-archive.bin`

The generated paths and their ancestors were checked for symlink redirects before
and after building. Existing generated directory contents contained no symlinks.
No output path redirected to unrelated data. The baseline archive remained intact.

### Staged result and remaining limits

The verified executable is staged at:

```text
/home/grant/.local/share/openchamber-stack/builds/opencode/3f70e97e41ae20cb9c0a89b29b661de1008f5de9/bin/opencode
```

- Version: `2.2.5+grant.2`; channel: `local`; target: `linux-x64-baseline`.
- Size: 271,423,664 bytes.
- SHA-256:
  `499182172c7082fc34aa0b2ce11012ad66bf28de2403653ac26e13c3fcfe417c`.
- Manifest: `manifest.json` in the staged source-commit directory.
- Manifest SHA-256:
  `962673597ffc9e528a6d21513894c6c3b44626b9a2d6cbb0bdfabf7f3f036511`.

The artifact is an independent verified copy, not a hard link. The staged
directory was created exclusively. The binary and staged directories are mode
0500; the manifest is mode 0400. Never rebuild or replace this source-commit path
in place. Read-only permissions are not an immutable filesystem attribute or an
operating-system sandbox.

Private records are in `opencode-build/accepted-grant-2/`: `rebuild.py`,
`build.json`, `build.log`, `stage.py`, `stage.json`, and the baseline archive and
manifest. The original build records remain unchanged. The staged manifest records
all approved generated output paths and the permitted cache locations.

The reviewer identified nonblocking test gaps for later profile coverage:
invalid/empty flag values and explicit assertions for existing project/Claude
options. These do not authorize post-review source changes.

Neither executable was run, including `--version`. No runtime profile or database,
provider authentication, model request, service activation, dependency reinstall,
or push occurred. Execution and activation still require separate approval.
This follow-up commit changes only the owned ledger; the staged artifact's source
remains the exact accepted commit above.

## 2026-10-31: test-only private discovery coverage

Main authorized this separate test task after recording the accepted artifact.
The artifact was not rebuilt or executed. Production source, manifests, lockfiles,
and patches remain identical to accepted source
`3f70e97e41ae20cb9c0a89b29b661de1008f5de9`. This task changes only
`packages/cli/test/server-process-config.test.ts`, the new
`packages/cli/test/server-process-discovery.test.ts`, and this ledger.

### Direct scenarios and acquisition

The focused checks cover 43 direct scenarios, including 19 new scenarios:

- 24 flag cases: 8 distinct values across default, service, and stdio modes.
  Empty and invalid values have separate named cases. These add 6 cases.
- 8 explicit existing-option cases cover project and Claude defaults, both
  project aliases, project precedence, both Claude aliases, their OR behavior,
  and false values. These are new cases.
- 5 new acquired discovery cases cover private global and empty HOME `.agents`
  eligibility; system suppression with a positive fixture control; ancestor
  suppression; Claude suppression; and late-created outside-profile sentinels.
- 6 existing Server schema/forwarding cases were rerun without modification.

The acquired tests call the production `ServerProcess.configOptions` adapter and
actual Core `ConfigDiscovery.discover`. They do not copy source-selection logic.
Acquisition is restricted to the Node filesystem, production FSUtil, production
`Global.layerWith` with all-private paths, and a fixture `Location.Service`.
`ConfigDiscovery` is an Effect, not a separate service layer; the tests execute
that Effect in the acquired context. The live test harness also supplies its
normal test console and scoped cleanup.

A test-only FSUtil decorator passes the fixture root as the production `up`
method's `stop` option. It rejects outside paths before `resolve` or `isDir`
looks them up. This bounds ancestor enumeration without replacing Core's selector
or the production filesystem methods. Positive controls still discover the
synthetic legacy-home ancestors inside that boundary. This is a test boundary,
not a runtime sandbox or proof that production ancestor walking is bounded.

The launcher sets private matching HOME/OPENCODE_TEST_HOME, TMPDIR, XDG,
configuration and database paths before imports. Each acquired case supplies
private fixture paths and restores mutable environment values after use.
Schema-validated initial configuration denies every tool permission and every
current policy action, with no provider or plugin declarations. The tests do not
acquire a policy engine or claim those rules were enforced.

System controls use a custom synthetic system directory, never platform system
configuration. Legacy-home controls also use synthetic directories. No real
`/etc/opencode` contents or other user-home contents were inspected or modified.
The late case creates synthetic system, ancestor JSON, `.opencode`, `.claude`,
and `.agents` sentinels after initial discovery. Repeated discovery in the same
acquired context still excludes them, while controls confirm their eligibility
and presence when enabled. This tests re-enumeration, not watcher notifications.

Private global app configuration stays eligible. Private HOME `.agents` also
stays eligible and is explicitly checked empty. A future private profile must
keep that directory empty; these flags do not disable all home discovery.

### Checks, evidence, and limits

The CLI direct run passed 37 scenarios; the Server direct run passed 6.
Both focused files also passed 10 randomized repetitions with seed `1031`;
Server forwarding passed 10 repetitions. Repetition is stability evidence, not
additional scenario coverage. The final CLI package typecheck, focused oxlint,
Prettier check, and Git whitespace check passed. No full package suites or broad
application-acquiring checks were run under this restricted authorization.

The first test attempt exposed a test import-resolution mistake: CLI does not
have a direct Core package dependency. The tests now use explicit sibling source
imports without changing dependencies. The first typecheck found branded-path
expectation errors. The tests now use `AbsolutePath.make`, without unsafe casts.
Private logs retain both failures and their successful corrected checks.

Private evidence is under `opencode-build/discovery-tests/`, including the
launcher, preflight record, exact commands, logs, and completion record.
All 40 production `src` tree IDs match the accepted commit. Git also reports no
difference in any tracked path outside the 3 owned tests/ledger paths.
The complete comparisons, protected-file hash checks, and unchanged generated
binary, staged artifact, manifest, and baseline hashes are recorded there.

The Config loader, credential services, WellKnown, database, watcher, Project
resolver, plugin supervisor, providers, models, and server do not acquire.
Credential discovery and migration, configuration parsing/merge precedence,
policy enforcement, skill loading, watcher reloads, default platform system/MDM
paths, symlink behavior, Windows behavior, and runtime activation remain untested.
A source-path test is not credential-discovery coverage.

No executable, application, server, authentication flow, provider/model request,
runtime profile, runtime database, service change, dependency installation,
rebuild, or push occurred. Synthetic configuration fixtures are removed by scoped
cleanup. Execution and activation remain unauthorized.
