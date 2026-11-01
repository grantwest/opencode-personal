import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test"
import { Config } from "@opencode/core/config"
import { Schema } from "effect"
import { ServerOptions } from "../src/options"
import { createEmbeddedRoutes, createRoutes } from "../src/routes"

const configure = spyOn(Config, "configured")

afterEach(() => {
  configure.mockClear()
})

afterAll(() => {
  configure.mockRestore()
})

// Constructing the route layer calls the real Core option adapter, but does not acquire
// the layer, discover files, activate plugins, open a database, or bind a listener.
describe.each([
  ["foreground", createRoutes],
  ["embedded", createEmbeddedRoutes],
] as const)("%s configuration options", (_name, create) => {
  test.each([undefined, false, true])("forwards system=%s through the schema to Core", (system) => {
    const options = Schema.decodeUnknownSync(ServerOptions)({
      config: {
        ...(system === undefined ? {} : { system }),
        project: false,
        claude: false,
        content: "{}",
      },
    })

    create(options)

    expect(options.config?.system).toBe(system)
    expect(configure).toHaveBeenCalledTimes(1)
    expect(configure).toHaveBeenCalledWith({
      system,
      project: false,
      claude: false,
      file: undefined,
      content: "{}",
    })
    expect(configure.mock.calls[0]?.[0]).not.toHaveProperty("global")
  })
})
