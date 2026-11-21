export const REDACTED = "[redacted]"

const SENSITIVE_KEYS = new Set([
  "code",
  "state",
  "codeverifier",
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "clientsecret",
  "clientassertion",
  "assertion",
  "password",
  "secret",
  "apikey",
  "xapikey",
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
])

export function redact(value: unknown, secrets: readonly string[] = []): unknown {
  if (typeof value === "string") return redactText(value, secrets)
  if (value === null || typeof value === "number" || typeof value === "boolean" || value === undefined) return value
  if (typeof value === "bigint") return value.toString()
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets))
  if (typeof value !== "object") return String(value)
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, sensitive(key) ? REDACTED : redact(item, secrets)]),
  )
}

export function redactText(value: string, secrets: readonly string[] = []): string {
  const values = secrets.flatMap((secret) => {
    if (!secret) return []
    const encoded = encodeURIComponent(secret)
    return encoded === secret ? [secret] : [secret, encoded]
  })
  let result = value.replace(/Bearer\s+[^\s,;]+/gi, `Bearer ${REDACTED}`)
  for (const secret of [...new Set(values)].sort((a, b) => b.length - a.length)) {
    result = result.replaceAll(secret, REDACTED)
  }
  return result
}

export function redactURL(value: string | URL, secrets: readonly string[] = []): string {
  if (!URL.canParse(String(value))) return redactText(String(value), secrets)
  const url = new URL(value)
  for (const key of new Set(Array.from(url.searchParams.keys()))) {
    if (sensitive(key)) url.searchParams.set(key, REDACTED)
  }
  if (url.username) url.username = REDACTED
  if (url.password) url.password = REDACTED
  if (url.hash) url.hash = REDACTED
  return redactText(url.toString(), secrets)
}

export function redactHeaders(headers: Headers | Record<string, unknown>, secrets: readonly string[] = []) {
  const entries = headers instanceof Headers ? Array.from(headers.entries()) : Object.entries(headers)
  return Object.fromEntries(entries.map(([key, value]) => [key, sensitive(key) ? REDACTED : redact(value, secrets)]))
}

export function secretValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(secretValues)
  if (typeof value !== "object" || value === null) return []
  return Object.entries(value).flatMap(([key, item]) => {
    if (sensitive(key) && typeof item === "string") return [item]
    return secretValues(item)
  })
}

export function redactError(error: unknown, secrets: readonly string[] = [], depth = 0): unknown {
  if (!(error instanceof Error)) return redact(error, secrets)
  if (depth >= 4) return `${error.name}: ${redactText(error.message, secrets)}`
  return {
    name: error.name,
    message: redactText(error.message, secrets),
    ...(error.stack ? { stack: redactText(error.stack, secrets) } : {}),
    ...(error.cause === undefined ? {} : { cause: redactError(error.cause, secrets, depth + 1) }),
  }
}

function sensitive(key: string) {
  return SENSITIVE_KEYS.has(key.toLowerCase().replace(/[^a-z0-9]/g, ""))
}
