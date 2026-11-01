# Personal changes

## 2026-11-01: restore the upstream stable source

Grant requested removal of our production patch and custom tests. This normal
commit reverses the source changes from `3f70e97e4`, `126da8005`, and `9f8d21489`.
It does not rewrite history or push. All production source trees and all other
tracked files now match upstream `v2.2.5`, commit
`9bbb8ce18c80f099e0e448775f59d965ead40a21`, except this ledger.
No replacement patch was added. `OPENCODE_CONFIG_SYSTEM_DISABLE` is no longer a
supported CLI control. Main owns deployment configuration and services.

The 5 earlier local commits, original files, and full ledger are preserved in
Git history and a private verified bundle and archive under:

```text
/home/grant/.local/state/sysadmin-maintenance/opencode-source-revert-2026-11-01-f4aXAV/
```

The preserved `2.2.5+grant.1` binary was built from the exact unpatched upstream
commit above, with Bun `1.4.4`, channel `local`, and target
`linux-x64-baseline`. Its private path is:

```text
/home/grant/.local/state/sysadmin-maintenance/openchamber-source-setup-2026-10-31/opencode-build/accepted-grant-2/baseline/bin/opencode
```

Its verified SHA-256 is
`d7f50ef9a273433f367336a050b56bcd4da91d05b8a435bcdbfbe25f5b0dc173`;
its size is 271,423,664 bytes. The source matches this restored checkout, except
for this documentation-only ledger and build-time version/channel metadata.
The binary can be reused without rebuilding for this source requirement.
The archive has mode `0400`; Main must stage a separate executable copy.
Static inspection is not runtime validation.

The existing ignored CLI output still contains patched `2.2.5+grant.2`.
It was not rebuilt, replaced, deleted, or approved for this unpatched deployment.
Generated web assets, caches, dependencies, and prior evidence remain unchanged.
Neither binary was executed. No dependency installation, build, authentication,
model request, or host service change occurred.
