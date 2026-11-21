import { describe, expect, test } from "bun:test"
import type { SessionRequest } from "@opencode/plugin/effect/session"
import { applyOAuthHeaders, CLAUDE_CODE_IDENTITY, prependIdentity } from "./index.js"

describe("applyOAuthHeaders", () => {
  test("merges existing beta flags case-insensitively and sets Claude Code identity", () => {
    const headers: Record<string, string> = {
      "Anthropic-Beta": "interleaved-thinking-2025-05-14,oauth-2025-04-20",
      "X-Api-Key": "must-not-be-sent",
      "User-Agent": "stale-agent",
      Authorization: "stale-authorization",
      "x-existing": "preserved",
    }
    applyOAuthHeaders(headers, "2.1.280", "sk-ant-oat-access")
    expect(headers).toMatchObject({
      "anthropic-beta": "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14",
      accept: "application/json",
      "anthropic-dangerous-direct-browser-access": "true",
      "user-agent": "claude-cli/2.1.280",
      "x-app": "cli",
      "x-existing": "preserved",
      authorization: "Bearer sk-ant-oat-access",
    })
    expect(headers).not.toHaveProperty("Anthropic-Beta")
    expect(headers).not.toHaveProperty("X-Api-Key")
    expect(headers).not.toHaveProperty("User-Agent")
    expect(headers).not.toHaveProperty("Authorization")
  })

  test("supports a shared version override and is idempotent", () => {
    const headers: Record<string, string> = {}
    applyOAuthHeaders(headers, "2.2.0")
    applyOAuthHeaders(headers, "2.2.0")
    expect(headers["user-agent"]).toBe("claude-cli/2.2.0")
    expect(headers["anthropic-beta"]).toBe("claude-code-20250219,oauth-2025-04-20")
  })
})

describe("prependIdentity", () => {
  test("adds the identity ahead of the application system prompt exactly once", () => {
    const system: SessionRequest["system"] = [{ type: "text", text: "OpenCode instructions" }]
    prependIdentity(system)
    prependIdentity(system)
    expect(system.map((part) => part.text)).toEqual([CLAUDE_CODE_IDENTITY, "OpenCode instructions"])
  })

  test("moves an existing identity to the front without duplicating it", () => {
    const system: SessionRequest["system"] = [
      { type: "text", text: "Application" },
      { type: "text", text: CLAUDE_CODE_IDENTITY },
    ]
    prependIdentity(system)
    expect(system.map((part) => part.text)).toEqual([CLAUDE_CODE_IDENTITY, "Application"])
  })

  test("leaves an existing first identity and its metadata untouched", () => {
    const system: SessionRequest["system"] = [
      { type: "text", text: CLAUDE_CODE_IDENTITY, metadata: { source: "existing" } },
      { type: "text", text: "Application" },
    ]
    prependIdentity(system)
    expect(system[0]?.metadata).toEqual({ source: "existing" })
    expect(system).toHaveLength(2)
  })
})
