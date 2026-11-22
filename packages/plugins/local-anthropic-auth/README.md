# Anthropic OAuth

An opt-in OpenCode V2 plugin that adds direct **Claude Pro/Max OAuth** authentication to the existing `anthropic` provider. Requests continue to use OpenCode's native provider, tools, message conversion, and streaming implementation. Claude CLI and MCP are not used, and no Claude CLI credentials are read.

## Install

Install from this fork:

```sh
opencode plugin add 'git+https://github.com/grantwest/opencode-personal.git#path:packages/plugins/local-anthropic-auth'
```

For local development, add the directory to `plugins` in `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["./packages/plugins/local-anthropic-auth"],
}
```

The plugin is not activated merely by being present in the repository.

## Sign in

Open `/connect`, select **Anthropic**, then choose:

- **Claude Pro/Max (browser)** — loopback browser login, with an option to paste the final redirect URL.
- **Claude Pro/Max (copy code)** — headless authorization-code login.

The plugin creates an OpenCode-owned OAuth credential. Core stores it and serializes refreshes; rotated refresh tokens are persisted by the normal credential lifecycle. Existing API-key and environment authentication methods remain available.

Token exchange and refresh explicitly send `User-Agent: Bun/<runtime-version>` instead of inheriting OpenCode's process-wide user-agent, which Anthropic's token endpoint can reject with a generic `429`. If a `429` still occurs, wait for the indicated cooldown and start a fresh login with a new authorization code; single-use codes are not retried automatically. Token refreshes use a short cooldown after a `429` to avoid repeated endpoint requests.

The plugin writes structured INFO/WARN/ERROR logs for authorization setup, callback handling, pasted input parsing, token requests and responses, refresh completion, failures, and cooldowns. Logs include sanitized request/response bodies, headers, URLs, status codes, timing, expiry, and refresh-token rotation or retention. Authorization codes, OAuth state, PKCE verifiers, access/refresh tokens, authorization headers, API keys, cookies, and other recognized credentials are redacted. Raw pasted authorization input is never logged.

Subscription requests receive Claude Code's OAuth identity headers and system block, plus a Pi Pocket-style billing-classification block derived from the first user text. The billing block is prepended ahead of the identity and is idempotent across request hooks. Known OpenCode tool names are converted to Claude Code's canonical casing in definitions, previous tool calls, and native tool updates (`read` → `Read`, `todowrite` → `TodoWrite`); unknown names such as `question` remain unchanged. OpenCode dispatches renamed calls to the original native tools without response or SSE rewriting. API-key requests are not modified. Subscription models show zero cost while the plugin's OAuth credential is active.

Subscription requests report a Claude Code version in both the `user-agent` header and the billing block's `cc_version`. The plugin seeds it at `2.1.322`. When Anthropic rejects a model request once with `claude_code_version_too_old`, the plugin adopts the version that rejection requires, stores it for later processes, and retries the request once with the adopted version. The stored value only ever moves up and is ignored if it is below the current seed, so a stale or corrupt value cannot lower the reported version. The seed is only a starting point; no configuration is required.

## Scope

The plugin ports the OAuth and request-identity behavior of `opencode-anthropic-auth` and pi-ai. It includes Pi Pocket-style billing classification and pi-ai's fixed-list tool-name canonicalization for subscription inference requests. It does not include quota-waiting `LimitGate`, the old `mcp_` tool transformation, raw body/SSE rewriting, or Claude Agent SDK subprocesses.

## Remove

```sh
opencode plugin remove 'git+https://github.com/grantwest/opencode-personal.git#path:packages/plugins/local-anthropic-auth'
```

If you installed with a different Git specification, pass that same specification to remove it. Removing the plugin leaves standard Anthropic API-key behavior intact.
