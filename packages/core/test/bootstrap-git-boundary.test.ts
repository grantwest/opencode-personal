import path from "path"
import os from "os"
import fs from "fs/promises"
import { createHash } from "crypto"
import { expect } from "bun:test"
import { Effect, FileSystem, Layer } from "effect"
import { ChildProcess } from "effect/process"
import { Git } from "@opencode/core/git"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { FSUtil } from "@opencode/util/fs-util"
import { AppProcess } from "@opencode/util/process"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { LayerNodePlatform } from "@opencode/util/effect/app-node-platform"
import { initGit } from "./fixture/git"
import { withEnv } from "./fixture/env"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

// Hash metadata names, types, modes and bytes, not access times changed by reading.
async function metadata(directory: string) {
  const hash = createHash("sha256")
  async function visit(relative: string) {
    const target = path.join(directory, relative)
    const info = await fs.lstat(target)
    if (!info.isDirectory() && !info.isFile()) throw new Error("Unexpected fixture metadata type")
    hash.update(JSON.stringify([relative, info.mode, info.isDirectory() ? "directory" : "file"]))
    if (info.isDirectory()) {
      for (const name of (await fs.readdir(target)).sort()) await visit(path.join(relative, name))
    } else hash.update(await fs.readFile(target))
  }
  await visit("")
  return hash.digest("hex")
}

// Keep the selectors unchanged. Guard the real filesystem methods so an unexpected
// walk beyond the fixture fails BEFORE looking up a real home or other host path.
function selectors(root: string) {
  const check = (target: string) => {
    const relative = path.relative(root, path.resolve(target))
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new Error(`Selector attempted a path outside its fixture: ${target}`)
  }
  const filesystem = Layer.effect(
    FileSystem.FileSystem,
    Effect.gen(function* () {
      const real = yield* FileSystem.FileSystem
      return FileSystem.FileSystem.of({
        ...real,
        exists: (target) => Effect.sync(() => check(target)).pipe(Effect.andThen(real.exists(target))),
        realPath: (target) => Effect.sync(() => check(target)).pipe(Effect.andThen(real.realPath(target))),
        stat: (target) => Effect.sync(() => check(target)).pipe(Effect.andThen(real.stat(target))),
        access: (target) => Effect.sync(() => check(target)).pipe(Effect.andThen(real.access(target))),
      })
    }),
  ).pipe(Layer.provide(LayerNode.compile(LayerNodePlatform.filesystem)))
  return LayerNode.compile(LayerNode.group([Git.node, FSUtil.node, AppProcess.node]), {
    replacements: [LayerNodePlatform.filesystem.replace(filesystem)],
  })
}

type Fixture = { ancestor: AbsolutePath; bootstrap: AbsolutePath; child: AbsolutePath; template: string; root: string }

function withRepositories<A, E>(
  scenario: string,
  body: (fixture: Fixture) => Effect.Effect<A, E, Git.Service | FSUtil.Service | AppProcess.Service>,
) {
  return tmpdirScoped("opencode-bootstrap-boundary-").pipe(
    Effect.flatMap(({ path: root }) => {
      const ancestor = AbsolutePath.make(path.join(root, "ancestor-home"))
      const bootstrap = AbsolutePath.make(path.join(ancestor, ".local", "share", "stack", "bootstrap-workspace"))
      const child = AbsolutePath.make(path.join(bootstrap, "child"))
      const home = path.join(root, "private-home")
      const temporary = path.join(root, "tmp")
      const template = path.join(root, "empty-template")
      const trace = path.join(root, "git.trace")
      const evidence = process.env.OPENCODE_BOOTSTRAP_TEST_EVIDENCE
      return Effect.promise(() =>
        Promise.all([child, home, temporary, template].map((directory) => fs.mkdir(directory, { recursive: true }))),
      ).pipe(
        Effect.andThen(
          withEnv(
            {
              ...Object.fromEntries(
                Object.keys(process.env)
                  .filter((name) => name.startsWith("GIT_"))
                  .map((name) => [name, undefined]),
              ),
              HOME: home,
              USERPROFILE: home,
              OPENCODE_TEST_HOME: home,
              TMPDIR: temporary,
              TMP: temporary,
              TEMP: temporary,
              XDG_CONFIG_HOME: path.join(home, "config"),
              XDG_DATA_HOME: path.join(home, "data"),
              XDG_CACHE_HOME: path.join(home, "cache"),
              XDG_STATE_HOME: path.join(home, "state"),
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_CONFIG_SYSTEM: os.devNull,
              GIT_CONFIG_GLOBAL: os.devNull,
              GIT_CONFIG_COUNT: "0",
              GIT_TERMINAL_PROMPT: "0",
              GIT_OPTIONAL_LOCKS: "0",
              GIT_TEMPLATE_DIR: template,
              GIT_CEILING_DIRECTORIES: ancestor,
              GIT_TRACE: trace,
              OPENCODE_CONFIG_SYSTEM_DISABLE: "1",
              OPENCODE_CONFIG_PROJECT_DISABLE: "1",
              OPENCODE_DISABLE_CLAUDE_CODE: "1",
            },
            () =>
              Effect.gen(function* () {
                yield* Effect.promise(() => initGit(ancestor, `--template=${template}`, "--initial-branch=main"))
                const before = yield* Effect.promise(() => metadata(path.join(ancestor, ".git")))
                return yield* body({ ancestor, bootstrap, child, template, root }).pipe(
                  Effect.provide(selectors(root)),
                  Effect.ensuring(
                    Effect.promise(async () => {
                      const after = await metadata(path.join(ancestor, ".git"))
                      const commands = (await fs.readFile(trace, "utf8"))
                        .split("\n")
                        .filter((line) => line.includes("trace: built-in:"))
                      if (evidence)
                        await fs.appendFile(
                          evidence,
                          JSON.stringify({
                            scenario,
                            ancestorMetadataSha256Before: before,
                            ancestorMetadataSha256After: after,
                            gitBuiltins: commands.length,
                          }) + "\n",
                          { mode: 0o600 },
                        )
                      expect(after).toBe(before)
                    }),
                  ),
                )
              }),
          ),
        ),
      )
    }),
  )
}

const nativeRoot = Effect.fn("fixture.nativeRoot")(function* (directory: string) {
  const process = yield* AppProcess.Service
  return yield* process.run(
    ChildProcess.make("git", ["rev-parse", "--show-toplevel"], { cwd: directory, extendEnv: true, stdin: "ignore" }),
  )
})

it.live("ceiling alone stops native Git but not the actual filesystem selectors", () =>
  withRepositories("ceiling-only", (fixture) =>
    Effect.gen(function* () {
      const files = yield* FSUtil.Service
      const git = yield* Git.Service
      expect((yield* nativeRoot(fixture.child)).exitCode).toBe(128)
      const control = yield* withEnv({ GIT_CEILING_DIRECTORIES: undefined }, () => nativeRoot(fixture.child))
      expect(control.exitCode).toBe(0)
      expect(control.stdout.toString().trim()).toBe(fixture.ancestor)
      expect(yield* Project.root(files, fixture.child)).toBe(fixture.ancestor)
      const repository = yield* git.repo.discover(fixture.child)
      expect(repository?.worktree).toBe(fixture.ancestor)
      expect(repository?.gitDirectory).toBe(AbsolutePath.make(path.join(fixture.ancestor, ".git")))
      expect(repository?.commonDirectory).toBe(repository?.gitDirectory)
    }),
  ),
)

it.live("a fresh unborn nested Git root bounds the actual safe selectors", () =>
  withRepositories("nested-root", (fixture) =>
    Effect.gen(function* () {
      yield* Effect.promise(() => initGit(fixture.bootstrap, `--template=${fixture.template}`, "--initial-branch=main"))
      const files = yield* FSUtil.Service
      const git = yield* Git.Service
      const dotGit = AbsolutePath.make(path.join(fixture.bootstrap, ".git"))
      expect(yield* files.isDir(dotGit)).toBe(true)
      expect(yield* files.resolve(dotGit)).toBe(dotGit)
      expect(yield* files.exists(path.join(dotGit, "hooks"))).toBe(false)
      expect(yield* files.exists(path.join(dotGit, "objects", "info", "alternates"))).toBe(false)
      expect(yield* Project.root(files, fixture.child)).toBe(fixture.bootstrap)
      const native = yield* nativeRoot(fixture.child)
      expect(native.exitCode).toBe(0)
      expect(native.stdout.toString().trim()).toBe(fixture.bootstrap)
      const repository = yield* git.repo.discover(fixture.child)
      expect(repository?.worktree).toBe(fixture.bootstrap)
      expect(repository?.gitDirectory).toBe(dotGit)
      expect(repository?.commonDirectory).toBe(dotGit)
      if (!repository) throw new Error("Synthetic nested repository was not found")
      expect(yield* git.remote.get(repository)).toBeUndefined()
      expect(yield* git.history.rootCommits(repository)).toEqual([])
    }),
  ),
)

it.live("removing only fixture bootstrap metadata exposes the ancestor again despite the ceiling", () =>
  withRepositories("removed-marker", (fixture) =>
    Effect.gen(function* () {
      yield* Effect.promise(() => initGit(fixture.bootstrap, `--template=${fixture.template}`, "--initial-branch=main"))
      const files = yield* FSUtil.Service
      const git = yield* Git.Service
      expect(yield* Project.root(files, fixture.child)).toBe(fixture.bootstrap)
      expect((yield* git.repo.discover(fixture.child))?.worktree).toBe(fixture.bootstrap)
      // Move metadata only inside this disposable fixture. No real bootstrap is created.
      yield* Effect.promise(() =>
        fs.rename(path.join(fixture.bootstrap, ".git"), path.join(fixture.root, "retired-bootstrap.git")),
      )
      expect((yield* nativeRoot(fixture.child)).exitCode).toBe(128)
      expect(yield* Project.root(files, fixture.child)).toBe(fixture.ancestor)
      const repository = yield* git.repo.discover(fixture.child)
      expect(repository?.worktree).toBe(fixture.ancestor)
      expect(repository?.commonDirectory).toBe(AbsolutePath.make(path.join(fixture.ancestor, ".git")))
    }),
  ),
)

// Project.resolve is deliberately NOT called: acquiring Project.Service requires
// Database and Bus services. Testing its private closure through a copied function,
// a fake database, or a new production export would not meet this task's scope.
// The bootstrap guard, instruction loader and full bound Location also stay untested.
