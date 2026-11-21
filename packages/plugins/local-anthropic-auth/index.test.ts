import { describe, expect, test } from "bun:test"
import type { SessionContext, SessionRequest } from "@opencode/plugin/effect/session"
import { applyOAuthHeaders, CLAUDE_CODE_IDENTITY, prependIdentity, shapeSubscriptionRequest } from "./index.js"

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

describe("shapeSubscriptionRequest", () => {
  test("prepends the Pi Pocket billing block before identity and remains idempotent", () => {
    const request = {
      system: [{ type: "text", text: "OpenCode instructions" }],
      messages: [
        { role: "assistant", content: [{ type: "text", text: "Earlier response" }] },
        { role: "user", content: [{ type: "text", text: "Hello, world!" }] },
      ],
    } satisfies Pick<SessionRequest, "system" | "messages">

    shapeSubscriptionRequest(request)
    expect(request.system.map((part) => part.text)).toEqual([
      "x-anthropic-billing-header: cc_version=2.1.280.86f; cc_entrypoint=sdk-cli; cch=315f5;",
      CLAUDE_CODE_IDENTITY,
      "OpenCode instructions",
    ])

    shapeSubscriptionRequest(request)
    expect(request.system.map((part) => part.text)).toEqual([
      "x-anthropic-billing-header: cc_version=2.1.280.86f; cc_entrypoint=sdk-cli; cch=315f5;",
      CLAUDE_CODE_IDENTITY,
      "OpenCode instructions",
    ])
  })

  test("uses the configured Claude Code version in the billing block", () => {
    const system: SessionRequest["system"] = []
    const request = {
      system,
      messages: [{ role: "user", content: [{ type: "text", text: "Hello, world!" }] }],
    } satisfies Pick<SessionRequest, "system" | "messages">
    shapeSubscriptionRequest(request, "2.2.0")
    expect(request.system[0]?.text).toMatch(
      /^x-anthropic-billing-header: cc_version=2\.2\.0\.[0-9a-f]{3}; cc_entrypoint=sdk-cli; cch=315f5;$/,
    )
  })

  test("adds identity but no billing block when the request has no user text", () => {
    const request = {
      system: [{ type: "text", text: "Application" }],
      messages: [],
    } satisfies Pick<SessionRequest, "system" | "messages">
    shapeSubscriptionRequest(request)
    expect(request.system.map((part) => part.text)).toEqual([CLAUDE_CODE_IDENTITY, "Application"])
  })

  test("preserves an existing billing block and its metadata while moving it first", () => {
    const request = {
      system: [
        { type: "text", text: "Application" },
        {
          type: "text",
          text: "x-anthropic-billing-header: existing",
          metadata: { source: "existing" },
        },
      ],
      messages: [{ role: "user", content: [{ type: "text", text: "Hello, world!" }] }],
    } satisfies Pick<SessionRequest, "system" | "messages">
    shapeSubscriptionRequest(request)
    expect(request.system.map((part) => part.text)).toEqual([
      "x-anthropic-billing-header: existing",
      CLAUDE_CODE_IDENTITY,
      "Application",
    ])
    expect(request.system[0]?.metadata).toEqual({ source: "existing" })
  })

  test("canonicalizes tool definitions while preserving identity and unknown names", () => {
    const read = { description: "Read a file", input: { type: "object" } }
    const todo = { description: "Track work", input: { type: "object" } }
    const question = { description: "Ask a question", input: { type: "object" } }
    const tools: SessionContext["tools"] = { read, todowrite: todo, question }
    const request = {
      system: [],
      tools,
      messages: [{ role: "user", content: [{ type: "text", text: "Hello, world!" }] }],
    } satisfies Pick<SessionContext, "system" | "tools" | "messages">

    shapeSubscriptionRequest(request)

    expect(request.tools.Read).toBe(read)
    expect(request.tools.TodoWrite).toBe(todo)
    expect(request.tools.question).toBe(question)
    expect(request.tools).not.toHaveProperty("read")
    expect(request.tools).not.toHaveProperty("todowrite")
  })

  test("canonicalizes previous tool calls and native tool updates idempotently", () => {
    const messages: SessionContext["messages"] = [
      { role: "user", content: [{ type: "text", text: "Hello, world!" }] },
      {
        role: "assistant",
        content: [
          { type: "tool-call", id: "call-read", name: "READ", input: { path: "README.md" } },
          { type: "tool-call", id: "call-question", name: "question", input: {} },
        ],
      },
      {
        role: "system",
        content: [],
        tools: {
          add: [
            { type: "tool", name: "webfetch", description: "Fetch a URL", inputSchema: { type: "object" } },
            {
              type: "namespace",
              name: "files",
              tools: [{ type: "tool", name: "grep", description: "Search files", inputSchema: { type: "object" } }],
            },
          ],
          remove: ["todowrite", "question"],
        },
      },
    ]
    const request = { system: [], messages } satisfies Pick<SessionContext, "system" | "messages">

    shapeSubscriptionRequest(request)
    shapeSubscriptionRequest(request)

    expect(request.messages[1]).toMatchObject({
      content: [{ name: "Read" }, { name: "question" }],
    })
    expect(request.messages[2]).toMatchObject({
      tools: {
        add: [{ name: "WebFetch" }, { name: "files", tools: [{ name: "Grep" }] }],
        remove: ["TodoWrite", "question"],
      },
    })
  })
})
