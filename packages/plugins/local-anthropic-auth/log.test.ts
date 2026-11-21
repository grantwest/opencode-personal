import { describe, expect, test } from "bun:test"
import { REDACTED, redact, redactError, redactHeaders, redactText, redactURL, secretValues } from "./log.js"

describe("OAuth log redaction", () => {
  test("redacts nested secrets, bearer tokens, and secret values embedded in diagnostic text", () => {
    expect(
      redact(
        {
          accessToken: "access-secret",
          nested: { "refresh-token": "refresh-secret" },
          message: "response echoed access-secret and refresh-secret",
          authorization: "Bearer untracked-secret",
          requestID: "request-visible",
        },
        ["access-secret", "refresh-secret"],
      ),
    ).toEqual({
      accessToken: REDACTED,
      nested: { "refresh-token": REDACTED },
      message: `response echoed ${REDACTED} and ${REDACTED}`,
      authorization: REDACTED,
      requestID: "request-visible",
    })
  })

  test("redacts URL credentials, sensitive query parameters, fragments, and encoded secret copies", () => {
    const output = redactURL(
      "https://user:password@example.com/callback?code=a%2Fb&state=state-secret&request_id=visible#fragment",
      ["a/b", "state-secret"],
    )
    const url = new URL(output)
    expect(url.searchParams.get("code")).toBe(REDACTED)
    expect(url.searchParams.get("state")).toBe(REDACTED)
    expect(url.searchParams.get("request_id")).toBe("visible")
    expect(output).not.toContain("user")
    expect(output).not.toContain("password")
    expect(output).not.toContain("a%2Fb")
    expect(output).not.toContain("a/b")
    expect(output).not.toContain("state-secret")
    expect(output).not.toContain("fragment")
    expect(redactText("echo=a%2Fb", ["a/b"])).toBe(`echo=${REDACTED}`)
  })

  test("redacts headers without hiding unrelated diagnostics", () => {
    expect(
      redactHeaders(
        {
          authorization: "Bearer header-secret",
          "x-api-key": "key-secret",
          cookie: "session=cookie-secret",
          "x-request-id": "request-visible",
        },
        ["header-secret"],
      ),
    ).toEqual({
      authorization: REDACTED,
      "x-api-key": REDACTED,
      cookie: REDACTED,
      "x-request-id": "request-visible",
    })
  })

  test("redacts nested error causes and discovers secrets across key naming conventions", () => {
    const error = new Error("request failed for token-secret", {
      cause: new Error("upstream returned token-secret"),
    })
    const output = JSON.stringify(redactError(error, ["token-secret"]))
    expect(output).toContain("request failed")
    expect(output).toContain("upstream returned")
    expect(output).not.toContain("token-secret")
    expect(secretValues({ accessToken: "one", nested: { refresh_token: "two", requestID: "visible" } })).toEqual([
      "one",
      "two",
    ])
  })
})
