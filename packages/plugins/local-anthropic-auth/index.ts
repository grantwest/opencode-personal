import { Credential, Plugin, Provider } from "@opencode/plugin/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { SessionContext, SessionRequest } from "@opencode/plugin/effect/session"
import { Effect, Stream } from "effect"
import { createHash } from "node:crypto"
import { BROWSER_METHOD_ID, browser, COPY_CODE_METHOD_ID, copyCode, INTEGRATION_ID } from "./oauth.js"

export const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."
export const DEFAULT_CLAUDE_CODE_VERSION = "2.1.280"

const REQUIRED_BETAS = ["claude-code-20250219", "oauth-2025-04-20"]
const BILLING_HEADER = "x-anthropic-billing-header:"
const BILLING_SALT = "59cf53e54c78"
const BILLING_POSITIONS = [4, 7, 20]
const CLAUDE_CODE_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "Bash",
  "Grep",
  "Glob",
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "KillShell",
  "NotebookEdit",
  "Skill",
  "Task",
  "TaskOutput",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
]
const CLAUDE_CODE_TOOL_NAMES = new Map(CLAUDE_CODE_TOOLS.map((name) => [name.toLowerCase(), name]))

type SubscriptionRequest = Pick<SessionRequest, "system" | "messages"> & Partial<Pick<SessionContext, "tools">>
type SystemMessage = Extract<SessionRequest["messages"][number], { role: "system" }>
type ToolEntry = NonNullable<SystemMessage["tools"]>["add"][number]

export default Plugin.define({
  id: "opencode.anthropic-auth",
  effect: Effect.fn("AnthropicAuth.Plugin")(function* (ctx) {
    const version = claudeCodeVersion(ctx.options)

    yield* ctx.integration.transform((editor) => {
      editor.method.update(browser())
      editor.method.update(copyCode())
    })

    const hook = (event: SubscriptionRequest) =>
      Effect.gen(function* () {
        if (!(yield* activeSubscription(ctx))) return
        shapeSubscriptionRequest(event, version)
      })
    yield* ctx.session.hook("context", hook, { providerID: Provider.ID.anthropic })
    yield* ctx.session.hook("compaction", hook, { providerID: Provider.ID.anthropic })
    yield* ctx.session.hook("generate", hook, { providerID: Provider.ID.anthropic })
    yield* ctx.session.hook("title", hook, { providerID: Provider.ID.anthropic })

    yield* ctx.session.hook(
      "model.request",
      Effect.fn("AnthropicAuth.headers")(function* (event) {
        const credential = yield* activeSubscription(ctx)
        if (!credential) return
        applyOAuthHeaders(event.headers, version, credential.access)
      }),
      { providerID: Provider.ID.anthropic },
    )

    const current = { subscription: yield* activeSubscription(ctx).pipe(Effect.map((value) => value !== undefined)) }
    yield* ctx.model.transform((editor) => {
      if (!current.subscription) return
      for (const model of editor.list(Provider.ID.anthropic)) {
        editor.update(model.providerID, model.id, (draft) => {
          draft.cost = []
        })
      }
    })
    yield* ctx.event.subscribe({ types: ["credential.switched"] }).pipe(
      Stream.filter((event) => event.data.integrationID === INTEGRATION_ID),
      Stream.runForEach(() =>
        Effect.gen(function* () {
          const next = yield* activeSubscription(ctx).pipe(Effect.map((value) => value !== undefined))
          if (next === current.subscription) return
          current.subscription = next
          yield* ctx.model.reload()
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
})

export function prependIdentity(system: SessionRequest["system"]) {
  const existing = system.findIndex((part) => part.text === CLAUDE_CODE_IDENTITY)
  if (existing === 0) return
  if (existing > 0) system.splice(existing, 1)
  system.unshift({ type: "text", text: CLAUDE_CODE_IDENTITY })
}

export function shapeSubscriptionRequest(request: SubscriptionRequest, version = DEFAULT_CLAUDE_CODE_VERSION) {
  canonicalizeToolNames(request)
  prependIdentity(request.system)
  const existing = request.system.findIndex((part) => part.text.startsWith(BILLING_HEADER))
  if (existing === 0) return
  if (existing > 0) {
    const billing = request.system.splice(existing, 1)[0]
    if (billing) request.system.unshift(billing)
    return
  }
  const text = firstUserText(request.messages)
  if (!text) return
  const sampled = BILLING_POSITIONS.map((index) => text[index] ?? "0").join("")
  const suffix = createHash("sha256").update(`${BILLING_SALT}${sampled}${version}`).digest("hex").slice(0, 3)
  const cch = createHash("sha256").update(text).digest("hex").slice(0, 5)
  request.system.unshift({
    type: "text",
    text: `${BILLING_HEADER} cc_version=${version}.${suffix}; cc_entrypoint=sdk-cli; cch=${cch};`,
  })
}

function firstUserText(messages: SessionRequest["messages"]) {
  for (const message of messages) {
    if (message.role !== "user") continue
    return message.content.find((part) => part.type === "text")?.text ?? ""
  }
  return ""
}

function canonicalizeToolNames(request: Pick<SubscriptionRequest, "messages" | "tools">) {
  if (request.tools) {
    for (const [name, definition] of Object.entries(request.tools)) {
      const canonical = claudeCodeToolName(name)
      if (canonical === name || request.tools[canonical]) continue
      request.tools[canonical] = definition
      delete request.tools[name]
    }
  }
  request.messages = request.messages.map((message) => {
    if (message.role === "assistant" && message.content.some((part) => part.type === "tool-call")) {
      return {
        ...message,
        content: message.content.map((part) =>
          part.type === "tool-call" ? { ...part, name: claudeCodeToolName(part.name) } : part,
        ),
      }
    }
    if (message.role !== "system" || !message.tools) return message
    return {
      ...message,
      tools: {
        add: message.tools.add.map(canonicalizeToolEntry),
        remove: message.tools.remove.map(claudeCodeToolName),
      },
    }
  })
}

function canonicalizeToolEntry(entry: ToolEntry): ToolEntry {
  if (entry.type === "namespace") return { ...entry, tools: entry.tools.map(canonicalizeToolEntry) }
  return { ...entry, name: claudeCodeToolName(entry.name) }
}

function claudeCodeToolName(name: string) {
  return CLAUDE_CODE_TOOL_NAMES.get(name.toLowerCase()) ?? name
}

export function applyOAuthHeaders(
  headers: Record<string, string>,
  version = DEFAULT_CLAUDE_CODE_VERSION,
  accessToken?: string,
) {
  const beta = Object.keys(headers).find((name) => name.toLowerCase() === "anthropic-beta")
  const existing = (beta ? headers[beta] : undefined)
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean)
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() === "x-api-key") delete headers[name]
  }
  if (beta && beta !== "anthropic-beta") delete headers[beta]
  setHeader(headers, "anthropic-beta", [...new Set([...REQUIRED_BETAS, ...(existing ?? [])])].join(","))
  setHeader(headers, "accept", "application/json")
  setHeader(headers, "anthropic-dangerous-direct-browser-access", "true")
  setHeader(headers, "user-agent", `claude-cli/${version}`)
  setHeader(headers, "x-app", "cli")
  if (accessToken) setHeader(headers, "authorization", `Bearer ${accessToken}`)
}

function setHeader(headers: Record<string, string>, name: string, value: string) {
  for (const existing of Object.keys(headers)) {
    if (existing !== name && existing.toLowerCase() === name.toLowerCase()) delete headers[existing]
  }
  headers[name] = value
}

function activeSubscription(ctx: Context) {
  return Effect.gen(function* () {
    const connection = yield* ctx.integration.connection.active(INTEGRATION_ID)
    if (!connection) return
    const credential = yield* ctx.integration.connection.resolve(connection).pipe(Effect.orElseSucceed(() => undefined))
    return isSubscription(credential) ? credential : undefined
  })
}

function isSubscription(credential: Credential.Value | undefined): credential is Credential.OAuth {
  return (
    credential?.type === "oauth" &&
    (credential.methodID === BROWSER_METHOD_ID || credential.methodID === COPY_CODE_METHOD_ID)
  )
}

function claudeCodeVersion(options: Context["options"]) {
  const version = options.claudeCodeVersion
  return typeof version === "string" && /^\d+\.\d+\.\d+$/.test(version) ? version : DEFAULT_CLAUDE_CODE_VERSION
}
