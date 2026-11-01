import { afterEach, describe, expect, test } from "bun:test"
import { ServerProcess } from "../src/server-process"

const previous = Object.fromEntries(
  [
    "OPENCODE_CONFIG_SYSTEM_DISABLE",
    "OPENCODE_CONFIG_PROJECT_DISABLE",
    "OPENCODE_DISABLE_PROJECT_CONFIG",
    "OPENCODE_DISABLE_CLAUDE_CODE",
    "OPENCODE_DISABLE_CLAUDE_CODE_SKILLS",
  ].map((name) => [name, process.env[name]]),
)

afterEach(() => {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

const values = [
  ["unset", undefined, false],
  ["empty", "", false],
  ["invalid", "invalid", false],
  ["false", "false", false],
  ["zero", "0", false],
  ["one", "1", true],
  ["true", "true", true],
  ["uppercase true", "TRUE", true],
] as const
const modes = ["default", "service", "stdio"] as const

describe.each(modes)("system configuration discovery in %s mode", (mode) => {
  test.each(values)("maps the %s flag without disabling global config", (_name, value, disabled) => {
    if (value === undefined) delete process.env.OPENCODE_CONFIG_SYSTEM_DISABLE
    else process.env.OPENCODE_CONFIG_SYSTEM_DISABLE = value

    const options = ServerProcess.configOptions(mode)
    expect(options.system).toBe(mode === "default" && disabled ? false : undefined)
    expect(options).not.toHaveProperty("global")
    expect(options.directory).toBe(process.env.OPENCODE_CONFIG_DIR)
    expect(options.file).toBe(process.env.OPENCODE_CONFIG)
    expect(options.content).toBe(process.env.OPENCODE_CONFIG_CONTENT)
  })
})

describe("existing project and Claude options", () => {
  test.each([
    ["defaults", undefined, undefined, undefined, undefined, true, true],
    ["project opt-out", "1", undefined, undefined, undefined, false, true],
    ["legacy project opt-out", undefined, "1", undefined, undefined, false, true],
    ["explicit project false overrides legacy opt-out", "false", "1", undefined, undefined, true, true],
    ["Claude opt-out", undefined, undefined, "1", undefined, true, false],
    ["Claude skills opt-out", undefined, undefined, undefined, "1", true, false],
    ["Claude skills opt-out survives explicit Claude false", undefined, undefined, "false", "1", true, false],
    ["false flags preserve discovery", "false", "false", "false", "false", true, true],
  ] as const)("%s", (_name, current, legacy, main, skills, project, claude) => {
    for (const [name, value] of Object.entries({
      OPENCODE_CONFIG_PROJECT_DISABLE: current,
      OPENCODE_DISABLE_PROJECT_CONFIG: legacy,
      OPENCODE_DISABLE_CLAUDE_CODE: main,
      OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: skills,
    })) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }

    const options = ServerProcess.configOptions("default")
    expect(options.project).toBe(project)
    expect(options.claude).toBe(claude)
    expect(options).not.toHaveProperty("global")
  })
})
