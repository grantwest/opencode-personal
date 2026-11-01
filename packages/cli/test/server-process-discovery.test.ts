import path from "path"
import fs from "fs/promises"
import { expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { ConfigDiscovery } from "../../core/src/config/discovery"
import { Location } from "../../core/src/location"
import { AbsolutePath } from "@opencode/schema/schema"
import { Info } from "@opencode/schema/config"
import { ConfigPolicy } from "@opencode/schema/config/policy"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { withEnv } from "../../core/test/fixture/env"
import { location } from "../../core/test/fixture/location"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { testEffect } from "../../core/test/lib/effect"
import { ServerProcess } from "../src/server-process"

const it = testEffect(Layer.empty)
const initial = JSON.stringify(
  Schema.decodeUnknownSync(Info)({
    permissions: [{ action: "*", resource: "*", effect: "deny" }],
    policies: ConfigPolicy.Action.literals.map((action) => ({ action, resource: "*", effect: "deny" })),
    plugins: [],
    providers: {},
  }),
)

type Fixture = {
  root: string
  home: AbsolutePath
  config: AbsolutePath
  explicit: AbsolutePath
  system: AbsolutePath
  legacy: AbsolutePath
  ancestor: AbsolutePath
  directory: AbsolutePath
}

// Use production filesystem methods, but bound their real ancestor walk to the synthetic
// fixture. Reject a regression to a host system/home path BEFORE any filesystem lookup.
// This test boundary is not a runtime sandbox and does not select configuration sources.
function filesystem(root: string) {
  const check = (target: string) => {
    const relative = path.relative(root, path.resolve(target))
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new Error(`Discovery attempted a path outside its fixture: ${target}`)
  }
  return Layer.effect(
    FSUtil.Service,
    Effect.gen(function* () {
      const real = yield* FSUtil.Service
      return FSUtil.Service.of({
        ...real,
        resolve: (target) => Effect.sync(() => check(target)).pipe(Effect.andThen(real.resolve(target))),
        isDir: (target) => Effect.sync(() => check(target)).pipe(Effect.andThen(real.isDir(target))),
        up: (options) =>
          Effect.sync(() => check(options.start)).pipe(Effect.andThen(real.up({ ...options, stop: root }))),
      })
    }),
  ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
}

function withProfile<A, E>(
  body: (fixture: Fixture) => Effect.Effect<A, E, FSUtil.Service | Global.Service | Location.Service>,
) {
  return tmpdirScoped("opencode-private-discovery-").pipe(
    Effect.flatMap(({ path: root }) => {
      const profile = path.join(root, "profile")
      const home = AbsolutePath.make(path.join(profile, "home"))
      const data = path.join(profile, "xdg", "data", "opencode")
      const cache = path.join(profile, "xdg", "cache", "opencode")
      const config = AbsolutePath.make(path.join(profile, "xdg", "config", "opencode"))
      const state = path.join(profile, "xdg", "state", "opencode")
      const tmp = path.join(profile, "tmp")
      const legacy = AbsolutePath.make(path.join(root, "legacy-home"))
      const ancestor = AbsolutePath.make(path.join(legacy, "work"))
      const directory = AbsolutePath.make(path.join(ancestor, "repository"))
      const explicit = AbsolutePath.make(path.join(profile, "initial.json"))
      const fixture = {
        root,
        home,
        config,
        explicit,
        system: AbsolutePath.make(path.join(root, "system")),
        legacy,
        ancestor,
        directory,
      }
      const layers = Layer.mergeAll(
        filesystem(root),
        Global.layerWith({
          home,
          data,
          cache,
          config,
          state,
          tmp,
          bin: path.join(cache, "bin"),
          log: path.join(data, "log"),
          repos: path.join(data, "repos"),
        }),
        Layer.succeed(Location.Service, location({ directory: AbsolutePath.make(directory) })),
      )
      return Effect.promise(async () => {
        await Promise.all([
          fs.mkdir(path.join(home, ".agents"), { recursive: true }),
          fs.mkdir(config, { recursive: true }),
          fs.mkdir(directory, { recursive: true }),
        ])
        await Promise.all([fs.writeFile(explicit, initial), fs.writeFile(path.join(config, "opencode.json"), initial)])
      }).pipe(
        Effect.andThen(
          withEnv(
            {
              HOME: home,
              OPENCODE_TEST_HOME: home,
              TMPDIR: tmp,
              XDG_CONFIG_HOME: path.dirname(config),
              XDG_DATA_HOME: path.dirname(data),
              XDG_CACHE_HOME: path.dirname(cache),
              XDG_STATE_HOME: path.dirname(state),
              OPENCODE_CONFIG_DIR: config,
              OPENCODE_CONFIG: explicit,
              OPENCODE_CONFIG_CONTENT: initial,
              OPENCODE_DB: path.join(data, "never-opened.db"),
              OPENCODE_CONFIG_SYSTEM_DISABLE: "1",
              OPENCODE_CONFIG_PROJECT_DISABLE: "1",
              OPENCODE_DISABLE_PROJECT_CONFIG: undefined,
              OPENCODE_DISABLE_CLAUDE_CODE: "1",
              OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
            },
            () => body(fixture).pipe(Effect.provide(layers)),
          ),
        ),
      )
    }),
  )
}

const seed = Effect.fn("fixture.seed")(function* (fixture: Fixture) {
  const files = yield* FSUtil.Service
  yield* files.writeWithDirs(path.join(fixture.system, "opencode.json"), initial)
  for (const root of [fixture.legacy, fixture.ancestor]) {
    yield* files.writeWithDirs(path.join(root, "opencode.json"), initial)
    yield* files.writeWithDirs(path.join(root, ".opencode", "opencode.json"), initial)
    yield* files.writeWithDirs(path.join(root, ".claude", "skills", "sentinel", "SKILL.md"), "Synthetic sentinel")
    yield* files.writeWithDirs(path.join(root, ".agents", "skills", "sentinel", "SKILL.md"), "Synthetic sentinel")
  }
  yield* files.writeWithDirs(path.join(fixture.home, ".claude", "skills", "sentinel", "SKILL.md"), "Synthetic sentinel")
})

function expectPrivate(sources: ConfigDiscovery.Sources, fixture: Fixture) {
  expect(sources).toEqual({
    system: undefined,
    preferences: undefined,
    global: fixture.config,
    explicit: fixture.explicit,
    direct: [],
    project: [],
    claude: [],
    agents: [AbsolutePath.make(path.join(fixture.home, ".agents"))],
  })
}

it.live("keeps private global app config and the empty private HOME .agents eligible", () =>
  withProfile((fixture) =>
    Effect.gen(function* () {
      const files = yield* FSUtil.Service
      const global = yield* Global.Service
      const options = ServerProcess.configOptions("default")
      expect(process.env.HOME).toBe(global.home)
      expect(process.env.OPENCODE_TEST_HOME).toBe(global.home)
      expect(process.env.TMPDIR).toBe(global.tmp)
      expect(options.content).toBe(initial)
      expectPrivate(yield* ConfigDiscovery.discover(options), fixture)
      expect(yield* files.isFile(path.join(fixture.config, "opencode.json"))).toBe(true)
      // These rules are schema-checked fixtures, not an acquired policy engine.
      // HOME .agents remains a discovery source and must stay empty in a future profile.
      expect(yield* files.readDirectory(path.join(fixture.home, ".agents"))).toEqual([])
    }),
  ),
)

it.live("excludes the synthetic system root with system:false, with a positive fixture control", () =>
  withProfile((fixture) =>
    Effect.gen(function* () {
      yield* seed(fixture)
      const options = ServerProcess.configOptions("default")
      expect(options.system).toBe(false)
      const control = yield* ConfigDiscovery.discover({ ...options, system: fixture.system })
      expect(control.system).toEqual({ path: fixture.system, present: true })
      expect(control.global).toBe(fixture.config)
      expectPrivate(yield* ConfigDiscovery.discover(options), fixture)
    }),
  ),
)

it.live("excludes synthetic legacy-home and other ancestor roots with project-disable", () =>
  withProfile((fixture) =>
    Effect.gen(function* () {
      yield* seed(fixture)
      const control = yield* withEnv({ OPENCODE_CONFIG_PROJECT_DISABLE: "false" }, () =>
        ConfigDiscovery.discover(ServerProcess.configOptions("default")),
      )
      for (const root of [fixture.legacy, fixture.ancestor]) {
        expect(control.direct).toContain(AbsolutePath.make(path.join(root, "opencode.json")))
        expect(control.project).toContainEqual({ path: AbsolutePath.make(path.join(root, ".opencode")), present: true })
        expect(control.agents).toContain(AbsolutePath.make(path.join(root, ".agents")))
      }
      expectPrivate(yield* ConfigDiscovery.discover(ServerProcess.configOptions("default")), fixture)
    }),
  ),
)

it.live("excludes private-home and ancestor Claude roots with Claude-disable", () =>
  withProfile((fixture) =>
    Effect.gen(function* () {
      yield* seed(fixture)
      yield* withEnv({ OPENCODE_CONFIG_PROJECT_DISABLE: "false" }, () =>
        Effect.gen(function* () {
          const control = yield* withEnv(
            { OPENCODE_DISABLE_CLAUDE_CODE: "false", OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "false" },
            () => ConfigDiscovery.discover(ServerProcess.configOptions("default")),
          )
          for (const root of [fixture.home, fixture.legacy, fixture.ancestor])
            expect(control.claude).toContain(AbsolutePath.make(path.join(root, ".claude")))
          const disabled = yield* ConfigDiscovery.discover(ServerProcess.configOptions("default"))
          expect(disabled.claude).toEqual([])
          expect(disabled.global).toBe(fixture.config)
          expect(disabled.agents).toContain(AbsolutePath.make(path.join(fixture.home, ".agents")))
        }),
      )
    }),
  ),
)

it.live("still excludes late-created outside-profile fixture sentinels in the same acquired context", () =>
  withProfile((fixture) =>
    Effect.gen(function* () {
      const files = yield* FSUtil.Service
      const options = ServerProcess.configOptions("default")
      expectPrivate(yield* ConfigDiscovery.discover(options), fixture)
      const absent = yield* ConfigDiscovery.discover({
        ...options,
        system: fixture.system,
        project: true,
        claude: true,
      })
      expect(absent.system).toEqual({ path: fixture.system, present: false })
      expect(absent.project).toContainEqual({
        path: AbsolutePath.make(path.join(fixture.legacy, ".opencode")),
        present: false,
      })
      expect(yield* files.isFile(path.join(fixture.legacy, "opencode.json"))).toBe(false)
      yield* seed(fixture)
      expectPrivate(yield* ConfigDiscovery.discover(ServerProcess.configOptions("default")), fixture)
      const present = yield* ConfigDiscovery.discover({
        ...options,
        system: fixture.system,
        project: true,
        claude: true,
      })
      expect(present.system).toEqual({ path: fixture.system, present: true })
      expect(present.project).toContainEqual({
        path: AbsolutePath.make(path.join(fixture.legacy, ".opencode")),
        present: true,
      })
      expect(present.direct).toContain(AbsolutePath.make(path.join(fixture.legacy, "opencode.json")))
      expect(present.claude).toContain(AbsolutePath.make(path.join(fixture.legacy, ".claude")))
      expect(present.agents).toContain(AbsolutePath.make(path.join(fixture.legacy, ".agents")))
      expect(yield* files.isFile(path.join(fixture.legacy, "opencode.json"))).toBe(true)
      expect(yield* files.readDirectory(path.join(fixture.home, ".agents"))).toEqual([])
    }),
  ),
)
