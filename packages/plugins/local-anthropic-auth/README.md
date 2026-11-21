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

Subscription requests receive Claude Code's OAuth identity headers and system block. API-key requests are not modified. Subscription models show zero cost while the plugin's OAuth credential is active.

Set a different reported Claude Code version when necessary:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "./packages/plugins/local-anthropic-auth",
      "options": { "claudeCodeVersion": "2.1.280" },
    },
  ],
}
```

Only numeric `major.minor.patch` values are accepted; invalid or missing values use `2.1.280`.

## Scope

The plugin ports the OAuth and request-identity behavior of `opencode-anthropic-auth` and pi-ai. It does not include Pi Pocket's optional billing-classification block, quota-waiting `LimitGate`, the old `mcp_` tool transformation, or Claude Agent SDK subprocesses.

## Remove

```sh
opencode plugin remove 'git+https://github.com/grantwest/opencode-personal.git#path:packages/plugins/local-anthropic-auth'
```

If you installed with a different Git specification, pass that same specification to remove it. Removing the plugin leaves standard Anthropic API-key behavior intact.
