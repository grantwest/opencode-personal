import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Logger } from "effect"
import { BROWSER_METHOD_ID, browser, COPY_CODE_METHOD_ID, copyCode, parseAuthorizationInput, refresh } from "./oauth.js"

function captureLogs() {
  const messages: unknown[] = []
  const layer = Logger.layer([Logger.make((entry) => messages.push(entry.message))])
  return {
    messages,
    provide: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.provide(layer)),
  }
}

describe("parseAuthorizationInput", () => {
  test("accepts redirect URLs, code#state, query input, and bare codes", () => {
    expect(parseAuthorizationInput("http://localhost/callback?code=abc&state=state", "state")).toEqual({
      code: "abc",
      state: "state",
    })
    expect(parseAuthorizationInput("abc#state", "state")).toEqual({ code: "abc", state: "state" })
    expect(parseAuthorizationInput("code=abc&state=state", "state")).toEqual({ code: "abc", state: "state" })
    expect(parseAuthorizationInput("abc", "state")).toEqual({ code: "abc", state: "state" })
  })

  test("rejects mismatched state, missing codes, provider errors, and empty input", () => {
    expect(() => parseAuthorizationInput("abc#other", "state")).toThrow("OAuth state mismatch")
    expect(() => parseAuthorizationInput("http://localhost/callback?state=state", "state")).toThrow("missing its code")
    expect(() => parseAuthorizationInput("http://localhost/callback?error=access_denied", "state")).toThrow(
      "access_denied",
    )
    expect(() => parseAuthorizationInput(" ", "state")).toThrow("Paste the authorization code")
  })
})

describe("copy-code OAuth", () => {
  test("exchanges a code with the same state, redirect, and S256 verifier without logging secrets", async () => {
    const requests: Record<string, string>[] = []
    const userAgents: (string | null)[] = []
    const logs = captureLogs()
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (request) => {
        userAgents.push(request.headers.get("user-agent"))
        requests.push((await request.json()) as Record<string, string>)
        return Response.json(
          {
            access_token: "sk-ant-oat-access",
            refresh_token: "refresh-one",
            expires_in: 3600,
            request_id: "response-request-id",
          },
          { headers: { "x-request-id": "header-request-id", "set-cookie": "session=cookie-secret" } },
        )
      },
    })
    try {
      const authorization = await Effect.runPromise(
        logs.provide(Effect.scoped(copyCode(server.url.toString()).authorize({}))),
      )
      expect(authorization.mode).toBe("code")
      if (authorization.mode !== "code") return

      const url = new URL(authorization.url)
      const state = url.searchParams.get("state")
      expect(state).toBeString()
      if (!state) return

      const credential = await Effect.runPromise(logs.provide(authorization.callback(`example-code#${state}`)))
      expect(credential).toMatchObject({
        type: "oauth",
        methodID: COPY_CODE_METHOD_ID,
        access: "sk-ant-oat-access",
        refresh: "refresh-one",
      })
      expect(requests).toHaveLength(1)
      expect(userAgents).toEqual([`Bun/${Bun.version}`])
      const body = requests[0]
      expect(body).toMatchObject({
        grant_type: "authorization_code",
        code: "example-code",
        state,
        redirect_uri: "https://platform.claude.com/oauth/code/callback",
      })
      const challenge = Buffer.from(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body.code_verifier)),
      ).toString("base64url")
      expect(url.searchParams.get("code_challenge")).toBe(challenge)
      expect(url.searchParams.get("code_challenge_method")).toBe("S256")

      const output = JSON.stringify(logs.messages)
      expect(output).toContain("anthropic oauth authorization ready")
      expect(output).toContain("anthropic oauth token request")
      expect(output).toContain("anthropic oauth token response")
      expect(output).toContain("authorization_code")
      expect(output).toContain("response-request-id")
      expect(output).toContain("header-request-id")
      expect(output).toContain("[redacted]")
      for (const secret of [
        "example-code",
        state,
        body.code_verifier,
        "sk-ant-oat-access",
        "refresh-one",
        "cookie-secret",
      ]) {
        expect(output).not.toContain(secret)
      }
    } finally {
      server.stop(true)
    }
  })

  test("redacts token values from malformed-response errors and logs", async () => {
    const logs = captureLogs()
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        Response.json({
          access_token: "malformed-access-secret",
          refresh_token: "malformed-refresh-secret",
          expires_in: "invalid",
        }),
    })
    try {
      const authorization = await Effect.runPromise(
        logs.provide(Effect.scoped(copyCode(server.url.toString()).authorize({}))),
      )
      expect(authorization.mode).toBe("code")
      if (authorization.mode !== "code") return
      const state = new URL(authorization.url).searchParams.get("state")
      expect(state).toBeString()
      if (!state) return

      const error = await Effect.runPromise(
        logs.provide(authorization.callback(`malformed-code#${state}`).pipe(Effect.flip)),
      )
      const output = `${error instanceof Error ? error.message : String(error)}\n${JSON.stringify(logs.messages)}`
      expect(output).toContain("expires_in")
      for (const secret of ["malformed-code", state, "malformed-access-secret", "malformed-refresh-secret"]) {
        expect(output).not.toContain(secret)
      }
    } finally {
      server.stop(true)
    }
  })
})

describe("browser OAuth", () => {
  test("finishes a loopback callback and logs diagnostics without callback or credential secrets", async () => {
    const requests: Record<string, string>[] = []
    const logs = captureLogs()
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (request) => {
        requests.push((await request.json()) as Record<string, string>)
        return Response.json({ access_token: "sk-ant-oat-browser", refresh_token: "browser-refresh", expires_in: 3600 })
      },
    })
    try {
      await Effect.runPromise(
        logs.provide(
          Effect.scoped(
            Effect.gen(function* () {
              const authorization = yield* browser(server.url.toString(), 0).authorize({})
              expect(authorization.mode).toBe("auto")
              if (authorization.mode !== "auto") return

              const url = new URL(authorization.url)
              const redirect = url.searchParams.get("redirect_uri")
              const state = url.searchParams.get("state")
              expect(redirect).toBeString()
              expect(state).toBeString()
              if (!redirect || !state) return

              const pending = yield* Effect.forkChild(authorization.callback, { startImmediately: true })
              const callback = new URL(redirect)
              callback.hostname = "127.0.0.1"
              callback.searchParams.set("code", "browser-code")
              callback.searchParams.set("state", state)
              const response = yield* Effect.promise(() =>
                fetch(callback, {
                  headers: {
                    authorization: "Bearer callback-access-secret",
                    "x-test-header": "visible-diagnostic",
                  },
                }),
              )
              expect(response.status).toBe(200)
              expect(yield* Fiber.join(pending)).toMatchObject({
                type: "oauth",
                methodID: BROWSER_METHOD_ID,
                access: "sk-ant-oat-browser",
                refresh: "browser-refresh",
              })
              expect(requests[0]).toMatchObject({ code: "browser-code", state, redirect_uri: redirect })
              yield* Effect.yieldNow

              const output = JSON.stringify(logs.messages)
              expect(output).toContain("anthropic oauth callback request")
              expect(output).toContain("anthropic oauth callback accepted")
              expect(output).toContain("anthropic oauth token request")
              expect(output).toContain("visible-diagnostic")
              for (const secret of [
                "browser-code",
                state,
                requests[0].code_verifier,
                "sk-ant-oat-browser",
                "browser-refresh",
                "callback-access-secret",
              ]) {
                expect(output).not.toContain(secret)
              }
            }),
          ),
        ),
      )
    } finally {
      server.stop(true)
    }
  })
})

describe("refresh", () => {
  test("logs the complete refresh path without old or new tokens", async () => {
    const requests: Record<string, string>[] = []
    const userAgents: (string | null)[] = []
    const logs = captureLogs()
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (request) => {
        userAgents.push(request.headers.get("user-agent"))
        requests.push((await request.json()) as Record<string, string>)
        return Response.json({ access_token: "new-access", expires_in: 3600 })
      },
    })
    try {
      const current = {
        type: "oauth" as const,
        methodID: COPY_CODE_METHOD_ID,
        access: "old-access",
        refresh: "old-refresh",
        expires: 0,
        metadata: { account: "example" },
      }
      const next = await Effect.runPromise(logs.provide(refresh(current, server.url.toString())))
      expect(next).toMatchObject({
        methodID: COPY_CODE_METHOD_ID,
        access: "new-access",
        refresh: "old-refresh",
        metadata: { account: "example" },
      })
      expect(requests[0]).toMatchObject({ grant_type: "refresh_token", refresh_token: "old-refresh" })
      expect(userAgents).toEqual([`Bun/${Bun.version}`])

      const output = JSON.stringify(logs.messages)
      expect(output).toContain("anthropic oauth refresh started")
      expect(output).toContain("anthropic oauth token request")
      expect(output).toContain("anthropic oauth token response")
      expect(output).toContain("anthropic oauth credential assembled")
      expect(output).toContain("anthropic oauth refresh completed")
      expect(output).toContain("refresh_token")
      expect(output).toContain("retained")
      for (const secret of ["old-access", "old-refresh", "new-access"]) {
        expect(output).not.toContain(secret)
      }
    } finally {
      server.stop(true)
    }
  })

  test("logs rate-limit responses and cooldowns while suppressing immediate duplicate refreshes", async () => {
    let requests = 0
    const logs = captureLogs()
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => {
        requests += 1
        return Response.json(
          { error: { type: "rate_limit_error", message: "Rate limited. Please try again later." } },
          { status: 429, headers: { "Retry-After": "60" } },
        )
      },
    })
    try {
      const current = {
        type: "oauth" as const,
        methodID: COPY_CODE_METHOD_ID,
        access: "rate-limited-access",
        refresh: `rate-limited-refresh-${crypto.randomUUID()}`,
        expires: 0,
      }
      await expect(Effect.runPromise(logs.provide(refresh(current, server.url.toString())))).rejects.toThrow(
        "Rate limited. Please try again later. Retry in 60s.",
      )
      await expect(Effect.runPromise(logs.provide(refresh(current, server.url.toString())))).rejects.toThrow("Retry in")
      expect(requests).toBe(1)

      const output = JSON.stringify(logs.messages)
      expect(output).toContain("anthropic oauth token error response")
      expect(output).toContain("rate_limit_error")
      expect(output).toContain("Rate limited. Please try again later.")
      expect(output).toContain("anthropic oauth refresh cooldown started")
      expect(output).toContain("anthropic oauth refresh blocked by cooldown")
      expect(output).not.toContain(current.access)
      expect(output).not.toContain(current.refresh)
    } finally {
      server.stop(true)
    }
  })
})
