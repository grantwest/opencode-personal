import { Credential, Plugin, Provider } from "@opencode/plugin/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { SessionRequest } from "@opencode/plugin/effect/session"
import { Effect, Stream } from "effect"
import { BROWSER_METHOD_ID, browser, COPY_CODE_METHOD_ID, copyCode, INTEGRATION_ID } from "./oauth.js"

export const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."
export const DEFAULT_CLAUDE_CODE_VERSION = "2.1.280"

const REQUIRED_BETAS = ["claude-code-20250219", "oauth-2025-04-20"]

export default Plugin.define({
  id: "opencode.anthropic-auth",
  effect: Effect.fn("AnthropicAuth.Plugin")(function* (ctx) {
    const version = claudeCodeVersion(ctx.options)

    yield* ctx.integration.transform((editor) => {
      editor.method.update(browser())
      editor.method.update(copyCode())
    })

    const hook = (event: SessionRequest) =>
      Effect.gen(function* () {
        if (!(yield* activeSubscription(ctx))) return
        prependIdentity(event.system)
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
