import { Credential, Integration } from "@opencode/plugin/effect"
import type {
  IntegrationOAuthAuthorization,
  IntegrationOAuthMethodRegistration,
} from "@opencode/plugin/effect/integration"
import { Deferred, Effect, Option, Schema } from "effect"
import { createHash } from "node:crypto"
import type { Server, ServerResponse } from "node:http"
import { redact, redactError, redactHeaders, redactText, redactURL, secretValues } from "./log.js"

export const INTEGRATION_ID = Integration.ID.make("anthropic")
export const BROWSER_METHOD_ID = Integration.MethodID.make("claude-browser")
export const COPY_CODE_METHOD_ID = Integration.MethodID.make("claude-copy-code")

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize"
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
const COPY_CODE_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback"
const CALLBACK_PATH = "/callback"
const SCOPES =
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload"

const Token = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.String),
  expires_in: Schema.Number.check(Schema.isGreaterThan(0)),
})
type Token = typeof Token.Type

type ExchangeInput = {
  readonly code: string
  readonly state: string
  readonly verifier: string
  readonly redirect: string
  readonly methodID: Integration.MethodID
  readonly tokenURL?: string
}

export function parseAuthorizationInput(input: string, expectedState: string) {
  const value = input.trim()
  if (!value) throw new Error("Paste the authorization code or redirect URL")

  if (URL.canParse(value)) {
    const params = new URL(value).searchParams
    const error = params.get("error_description") ?? params.get("error")
    if (error) throw new Error(error)
    return checked(params.get("code"), params.get("state"), expectedState)
  }
  if (value.includes("#")) {
    const [code, state] = value.split("#", 2)
    return checked(code, state, expectedState)
  }
  if (value.includes("code=")) {
    const params = new URLSearchParams(value)
    return checked(params.get("code"), params.get("state"), expectedState)
  }
  return checked(value, undefined, expectedState)
}

function checked(code: string | null | undefined, state: string | null | undefined, expectedState: string) {
  if (!code?.trim()) throw new Error("The authorization response is missing its code")
  if (state && state !== expectedState) throw new Error("OAuth state mismatch")
  return { code: code.trim(), state: state || expectedState }
}

export function exchange(input: ExchangeInput) {
  return requestToken(input.tokenURL ?? TOKEN_URL, {
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    code: input.code,
    state: input.state,
    redirect_uri: input.redirect,
    code_verifier: input.verifier,
  }).pipe(Effect.flatMap((tokens) => credential(tokens, input.methodID)))
}

export function refresh(value: Credential.OAuth, tokenURL = TOKEN_URL) {
  const key = createHash("sha256").update(value.refresh).digest("base64url")
  const secrets = [value.access, value.refresh]
  return Effect.gen(function* () {
    const remaining = (refreshCooldowns.get(key) ?? 0) - Date.now()
    yield* Effect.logInfo("anthropic oauth refresh started", {
      methodID: value.methodID,
      expires: value.expires,
      cooldownRemainingMs: Math.max(0, remaining),
    })
    if (remaining > 0) {
      yield* Effect.logWarning("anthropic oauth refresh blocked by cooldown", {
        methodID: value.methodID,
        retryAfterMs: remaining,
      })
      return yield* Effect.fail(
        new OAuthRequestError(
          `Anthropic OAuth is rate limited. Retry in ${Math.ceil(remaining / 1000)}s.`,
          429,
          remaining,
        ),
      )
    }
    return yield* requestToken(tokenURL, {
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: value.refresh,
    }).pipe(
      Effect.flatMap((tokens) => credential(tokens, value.methodID, value)),
      Effect.tap(() =>
        Effect.gen(function* () {
          refreshCooldowns.delete(key)
          yield* Effect.logInfo("anthropic oauth refresh completed", { methodID: value.methodID })
        }),
      ),
      Effect.tapError((error) =>
        Effect.gen(function* () {
          if (!(error instanceof OAuthRequestError) || error.status !== 429) {
            yield* Effect.logError("anthropic oauth refresh failed", {
              methodID: value.methodID,
              error: redactError(error, secrets),
            })
            return
          }
          const retryAfterMs = error.retryAfterMs ?? 60_000
          const cooldownUntil = Date.now() + retryAfterMs
          refreshCooldowns.set(key, cooldownUntil)
          yield* Effect.logWarning("anthropic oauth refresh cooldown started", {
            methodID: value.methodID,
            status: error.status,
            retryAfterMs,
            cooldownUntil,
          })
        }),
      ),
    )
  })
}

const refreshCooldowns = new Map<string, number>()

class OAuthRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(message)
  }
}

const ErrorResponse = Schema.Struct({
  error: Schema.optional(Schema.Unknown),
  error_description: Schema.optional(Schema.String),
})
const decodeErrorResponse = Schema.decodeUnknownOption(Schema.fromJsonString(ErrorResponse))

function requestToken(url: string, body: Record<string, string>) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": `Bun/${Bun.version}`,
  }
  const grantType = body.grant_type ?? "unknown"
  const secrets = secretValues(body)
  const started = Date.now()
  return Effect.gen(function* () {
    yield* Effect.logInfo("anthropic oauth token request", {
      grantType,
      method: "POST",
      url: redactURL(url, secrets),
      headers: redactHeaders(headers, secrets),
      body: redact(body, secrets),
      redirect: "error",
      timeoutMs: 30_000,
    })
    const result = yield* Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          redirect: "error",
          signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        })
        return { response, body: await response.text() }
      },
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    })
    const parsed = parseResponseBody(result.body)
    secrets.push(...secretValues(parsed))
    const fields = {
      grantType,
      url: redactURL(url, secrets),
      status: result.response.status,
      statusText: result.response.statusText,
      headers: redactHeaders(result.response.headers, secrets),
      body: redact(parsed, secrets),
      durationMs: Date.now() - started,
    }
    if (result.response.ok) yield* Effect.logInfo("anthropic oauth token response", fields)
    else yield* Effect.logWarning("anthropic oauth token error response", fields)
    if (!result.response.ok) {
      return yield* Effect.fail(oauthResponseError(result.response, result.body, secrets))
    }
    return yield* Schema.decodeUnknownEffect(Token)(parsed).pipe(
      Effect.mapError(
        (error) => new Error(redactText(error instanceof Error ? error.message : String(error), secrets)),
      ),
    )
  }).pipe(
    Effect.tapError((error) =>
      Effect.logError("anthropic oauth token request failed", {
        grantType,
        url: redactURL(url, secrets),
        durationMs: Date.now() - started,
        ...(error instanceof OAuthRequestError ? { status: error.status, retryAfterMs: error.retryAfterMs } : {}),
        error: redactError(error, secrets),
      }),
    ),
    Effect.onInterrupt(() =>
      Effect.logWarning("anthropic oauth token request interrupted", {
        grantType,
        url: redactURL(url, secrets),
        durationMs: Date.now() - started,
      }),
    ),
  )
}

function parseResponseBody(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    return body
  }
}

function oauthResponseError(response: Response, text: string, secrets: readonly string[]) {
  const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"))
  const body = Option.getOrUndefined(decodeErrorResponse(text))
  const detail = errorDetail(body?.error) ?? body?.error_description
  const safeDetail = detail ? redactText(detail, secrets) : undefined
  const suffix = `${safeDetail ? `: ${safeDetail}` : ""}${retryAfterMs === undefined ? "" : ` Retry in ${Math.ceil(retryAfterMs / 1000)}s.`}`
  if (response.status === 429) {
    return new OAuthRequestError(`Anthropic OAuth is rate limited${suffix}`, response.status, retryAfterMs)
  }
  return new OAuthRequestError(
    `Anthropic OAuth request failed (${response.status})${suffix}`,
    response.status,
    retryAfterMs,
  )
}

function errorDetail(error: unknown): string | undefined {
  if (typeof error === "string") return error
  if (typeof error !== "object" || error === null || !("message" in error)) return
  return typeof error.message === "string" ? error.message : undefined
}

function parseRetryAfter(value: string | null) {
  if (!value) return
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const date = Date.parse(value)
  if (Number.isFinite(date)) return Math.max(0, date - Date.now())
}

function credential(tokens: Token, methodID: Integration.MethodID, previous?: Credential.OAuth) {
  const refresh = tokens.refresh_token ?? previous?.refresh
  return Effect.gen(function* () {
    if (!tokens.access_token) {
      yield* Effect.logError("anthropic oauth credential rejected", { methodID, reason: "missing_access_token" })
      return yield* Effect.fail(new Error("Anthropic OAuth response is missing its access token"))
    }
    if (!refresh) {
      yield* Effect.logError("anthropic oauth credential rejected", { methodID, reason: "missing_refresh_token" })
      return yield* Effect.fail(new Error("Anthropic OAuth response is missing its refresh token"))
    }
    const expires = Math.max(0, Date.now() + tokens.expires_in * 1000 - 5 * 60 * 1000)
    yield* Effect.logInfo("anthropic oauth credential assembled", {
      methodID,
      expiresIn: tokens.expires_in,
      expires,
      refreshTokenDisposition: previous ? (refresh === previous.refresh ? "retained" : "rotated") : "issued",
      metadataPreserved: previous?.metadata !== undefined,
    })
    return Credential.OAuth.make({
      type: "oauth",
      methodID,
      refresh,
      access: tokens.access_token,
      expires,
      ...(previous?.metadata ? { metadata: previous.metadata } : {}),
    })
  })
}

export function browser(tokenURL = TOKEN_URL, preferredPort = 53692): IntegrationOAuthMethodRegistration {
  return {
    integrationID: INTEGRATION_ID,
    method: { id: BROWSER_METHOD_ID, type: "oauth", label: "Claude Pro/Max (browser)" },
    authorize: () =>
      Effect.gen(function* () {
        yield* Effect.logInfo("anthropic oauth browser authorization started", {
          tokenURL: redactURL(tokenURL),
          preferredPort,
        })
        const runFork = Effect.runForkWith(yield* Effect.context<never>())
        const pkce = yield* Effect.promise(generatePKCE)
        const state = randomValue()
        const received = yield* Deferred.make<{ code: string; response?: ServerResponse }, Error>()
        const { createServer } = yield* Effect.promise(() => import("node:http"))
        const server = createServer((request, response) => {
          const url = new URL(request.url ?? "/", "http://127.0.0.1")
          const secrets = [state, url.searchParams.get("code") ?? "", url.searchParams.get("state") ?? ""]
          const fields = {
            method: request.method,
            url: redactURL(url, secrets),
            headers: redactHeaders(request.headers, secrets),
            remoteAddress: request.socket.remoteAddress,
          }
          runFork(Effect.logInfo("anthropic oauth callback request", fields))
          if (url.pathname !== CALLBACK_PATH) {
            runFork(Effect.logWarning("anthropic oauth callback rejected", { ...fields, reason: "wrong_path" }))
            response.writeHead(404).end("Not found")
            return
          }
          const error = url.searchParams.get("error_description") ?? url.searchParams.get("error")
          if (error) {
            runFork(
              Effect.logWarning("anthropic oauth callback rejected", {
                ...fields,
                reason: "provider_error",
                error: redactText(error, secrets),
              }),
            )
            return failCallback(received, response, error)
          }
          const code = url.searchParams.get("code")
          if (!code) {
            runFork(Effect.logWarning("anthropic oauth callback rejected", { ...fields, reason: "missing_code" }))
            return failCallback(received, response, "Missing authorization code")
          }
          if (url.searchParams.get("state") !== state) {
            runFork(Effect.logWarning("anthropic oauth callback rejected", { ...fields, reason: "state_mismatch" }))
            return failCallback(received, response, "OAuth state mismatch")
          }
          if (!Effect.runSync(Deferred.succeed(received, { code, response }))) {
            runFork(Effect.logWarning("anthropic oauth callback rejected", { ...fields, reason: "already_received" }))
            response.writeHead(409).end("OAuth callback already received")
            return
          }
          runFork(Effect.logInfo("anthropic oauth callback accepted", fields))
        })
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            server.close()
            server.closeAllConnections()
          }).pipe(Effect.andThen(Effect.logInfo("anthropic oauth callback server closed"))),
        )
        const port = yield* listen(server, preferredPort).pipe(
          Effect.catch(() => listen(server, 0)),
          Effect.option,
        )
        if (Option.isNone(port)) {
          yield* Effect.logWarning("anthropic oauth callback server unavailable; using copy-code fallback")
          const authorization = codeAuthorization(pkce, state, BROWSER_METHOD_ID, tokenURL)
          yield* logAuthorization(BROWSER_METHOD_ID, "code", authorization.url, COPY_CODE_REDIRECT_URI)
          return authorization
        }

        const redirect = `http://localhost:${port.value}${CALLBACK_PATH}`
        const url = authorizeURL(redirect, pkce.challenge, state)
        yield* logAuthorization(BROWSER_METHOD_ID, "auto", url, redirect)
        return {
          mode: "auto" as const,
          url,
          instructions: "Complete authorization in your browser, or paste the final redirect URL.",
          callback: Deferred.await(received).pipe(
            Effect.flatMap((result) => {
              const secrets = [result.code, state, pkce.verifier]
              const respond = (error?: string) =>
                Effect.gen(function* () {
                  const status = error ? 400 : 200
                  yield* Effect.sync(() => {
                    result.response
                      ?.writeHead(status, { "Content-Type": "text/html; charset=utf-8" })
                      .end(callbackPage(error))
                  })
                  const fields = {
                    methodID: BROWSER_METHOD_ID,
                    status,
                    ...(error ? { error: redactText(error, secrets) } : {}),
                  }
                  if (error) yield* Effect.logWarning("anthropic oauth callback response sent", fields)
                  else yield* Effect.logInfo("anthropic oauth callback response sent", fields)
                })
              return exchange({
                code: result.code,
                state,
                verifier: pkce.verifier,
                redirect,
                methodID: BROWSER_METHOD_ID,
                tokenURL,
              }).pipe(
                Effect.tap(() => respond()),
                Effect.tapError((error) => respond(error instanceof Error ? error.message : String(error))),
                Effect.onInterrupt(() =>
                  Effect.sync(() => result.response?.destroy()).pipe(
                    Effect.andThen(
                      Effect.logWarning("anthropic oauth browser callback interrupted", {
                        methodID: BROWSER_METHOD_ID,
                      }),
                    ),
                  ),
                ),
              )
            }),
          ),
          submit: (text: string) =>
            Effect.gen(function* () {
              yield* Effect.logInfo("anthropic oauth browser manual callback submitted", {
                methodID: BROWSER_METHOD_ID,
                inputLength: text.length,
              })
              const input = yield* parseAuthorization(text, state)
              const accepted = yield* Deferred.succeed(received, { code: input.code })
              if (!accepted) {
                yield* Effect.logWarning("anthropic oauth browser manual callback rejected", {
                  methodID: BROWSER_METHOD_ID,
                  reason: "already_received",
                })
                return yield* Effect.fail(new Error("OAuth callback already received"))
              }
              yield* Effect.logInfo("anthropic oauth browser manual callback accepted", {
                methodID: BROWSER_METHOD_ID,
              })
            }),
        }
      }),
    refresh: (value) => refresh(value, tokenURL),
  }
}

export function copyCode(tokenURL = TOKEN_URL): IntegrationOAuthMethodRegistration {
  return {
    integrationID: INTEGRATION_ID,
    method: { id: COPY_CODE_METHOD_ID, type: "oauth", label: "Claude Pro/Max (copy code)" },
    authorize: () =>
      Effect.gen(function* () {
        yield* Effect.logInfo("anthropic oauth copy-code authorization started", {
          tokenURL: redactURL(tokenURL),
        })
        const pkce = yield* Effect.promise(generatePKCE)
        const authorization = codeAuthorization(pkce, randomValue(), COPY_CODE_METHOD_ID, tokenURL)
        yield* logAuthorization(COPY_CODE_METHOD_ID, "code", authorization.url, COPY_CODE_REDIRECT_URI)
        return authorization
      }),
    refresh: (value) => refresh(value, tokenURL),
  }
}

function codeAuthorization(
  pkce: { readonly verifier: string; readonly challenge: string },
  state: string,
  methodID: Integration.MethodID,
  tokenURL: string,
): IntegrationOAuthAuthorization {
  return {
    mode: "code",
    url: authorizeURL(COPY_CODE_REDIRECT_URI, pkce.challenge, state),
    instructions: "Complete authorization in your browser, then paste the code or final redirect URL.",
    callback: (input) =>
      Effect.gen(function* () {
        yield* Effect.logInfo("anthropic oauth authorization input received", {
          methodID,
          inputLength: input.length,
        })
        const parsed = yield* parseAuthorization(input, state)
        return yield* exchange({
          code: parsed.code,
          state: parsed.state,
          verifier: pkce.verifier,
          redirect: COPY_CODE_REDIRECT_URI,
          methodID,
          tokenURL,
        })
      }),
  }
}

function logAuthorization(methodID: Integration.MethodID, mode: "auto" | "code", url: string, redirect: string) {
  return Effect.logInfo("anthropic oauth authorization ready", {
    methodID,
    mode,
    authorizationURL: redactURL(url),
    redirectURI: redactURL(redirect),
  })
}

function parseAuthorization(input: string, state: string) {
  const trimmed = input.trim()
  const inputKind = !trimmed
    ? "empty"
    : URL.canParse(trimmed)
      ? "url"
      : trimmed.includes("#")
        ? "code-state"
        : trimmed.includes("code=")
          ? "query"
          : "bare-code"
  return Effect.try({
    try: () => parseAuthorizationInput(input, state),
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  }).pipe(
    Effect.tap((parsed) =>
      Effect.logInfo("anthropic oauth authorization input parsed", {
        inputLength: input.length,
        inputKind,
        authorization: redact(parsed, [state]),
      }),
    ),
    Effect.tapError((error) =>
      Effect.logWarning("anthropic oauth authorization input rejected", {
        inputLength: input.length,
        inputKind,
        error: redactError(error, [state]),
      }),
    ),
  )
}

function authorizeURL(redirect: string, challenge: string, state: string) {
  return `${AUTHORIZE_URL}?${new URLSearchParams({
    code: "true",
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: redirect,
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  })}`
}

async function generatePKCE() {
  const verifier = randomValue()
  const challenge = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString(
    "base64url",
  )
  return { verifier, challenge }
}

function randomValue() {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")
}

function listen(server: Server, port: number) {
  return Effect.callback<number, Error>((resume) => {
    const onError = (error: Error) => resume(Effect.fail(error))
    server.once("error", onError)
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError)
      const address = server.address()
      if (!address || typeof address === "string") return resume(Effect.fail(new Error("Missing OAuth callback port")))
      resume(Effect.succeed(address.port))
    })
  }).pipe(
    Effect.tap((actualPort) =>
      Effect.logInfo("anthropic oauth callback server listening", {
        host: "127.0.0.1",
        requestedPort: port,
        actualPort,
      }),
    ),
    Effect.tapError((error) =>
      Effect.logWarning("anthropic oauth callback server listen failed", {
        host: "127.0.0.1",
        requestedPort: port,
        error: redactError(error),
      }),
    ),
  )
}

function failCallback(
  received: Deferred.Deferred<{ code: string; response?: ServerResponse }, Error>,
  response: ServerResponse,
  message: string,
) {
  Effect.runFork(Deferred.fail(received, new Error(message)))
  response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" }).end(callbackPage(message))
}

function callbackPage(error?: string) {
  const title = error ? "Authorization failed" : "Authorization successful"
  const message = error ?? "OpenCode is now connected to Claude. You can close this window."
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><body style="font-family:system-ui;display:grid;place-items:center;min-height:80vh"><main><h1>${title}</h1><p>${escapeHtml(message)}</p></main></body></html>`
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}
