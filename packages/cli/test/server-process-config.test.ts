import { afterEach, describe, expect, test } from "bun:test"
import { ServerProcess } from "../src/server-process"

const previous = process.env.OPENCODE_CONFIG_SYSTEM_DISABLE

afterEach(() => {
  if (previous === undefined) delete process.env.OPENCODE_CONFIG_SYSTEM_DISABLE
  else process.env.OPENCODE_CONFIG_SYSTEM_DISABLE = previous
})

const values = [undefined, "false", "0", "1", "true", "TRUE"] as const
const modes = ["default", "service", "stdio"] as const

describe.each(modes)("system configuration discovery in %s mode", (mode) => {
  test.each(values)("maps OPENCODE_CONFIG_SYSTEM_DISABLE=%s without disabling global config", (value) => {
    if (value === undefined) delete process.env.OPENCODE_CONFIG_SYSTEM_DISABLE
    else process.env.OPENCODE_CONFIG_SYSTEM_DISABLE = value

    const options = ServerProcess.configOptions(mode)
    expect(options.system).toBe(
      mode === "default" && (value === "1" || value === "true" || value === "TRUE") ? false : undefined,
    )
    expect(options).not.toHaveProperty("global")
    expect(options.directory).toBe(process.env.OPENCODE_CONFIG_DIR)
    expect(options.file).toBe(process.env.OPENCODE_CONFIG)
    expect(options.content).toBe(process.env.OPENCODE_CONFIG_CONTENT)
  })
})
