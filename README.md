# opencode-provider-proxy

A plugin for [OpenCode v2](https://opencode.ai/v2/docs/) that routes the traffic
of **selected providers** through configured **forward proxies** (HTTP CONNECT
or SOCKS5, with optional authentication). The "provider → proxy" mapping is set
in the OpenCode config (`opencode.json(c)`) and can be edited live from a TUI
panel.

Providers that are not listed in the config are completely untouched and keep
using their direct connection.

## How it works

The server part (`src/index.ts`) starts a local HTTP gateway on
`127.0.0.1` (random port). For every provider assigned to a proxy it rewrites
that provider's `settings.baseURL` to point at the gateway and forces
`settings.transport: "http"`. The gateway resolves the original upstream URL for
each request and forwards it through the configured proxy using `proxy-agent`
(HTTP CONNECT or SOCKS5, including authentication), streaming both the request
and the response body.

The gateway is rebuilt whenever the config changes (including external saves and
`/reload`), so mapping updates apply without restarting OpenCode.

## Installation

The plugin has no published npm package yet; load it from a local path.

**Option 1 — auto-load from `.opencode/plugins/`.** Copy or symlink this package
directory into your project's `.opencode/plugins/` directory. Plugins under
`.opencode/plugins/` are discovered automatically:

```text
<project>/.opencode/
  plugins/
    provider-proxy/   <- this repo (or a symlink to it)
```

**Option 2 — reference it in the `plugins` array.** Add the local path to
`plugins` in your `opencode.json(c)`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "./plugins/provider-proxy"
  ]
}
```

Use an object entry to set options in the same place (see below):

```jsonc
"plugins": [
  {
    "package": "./plugins/provider-proxy",
    "options": { /* ... */ }
  }
]
```

## Configuration

Options are read from the plugin's `options` in `opencode.json(c)`:

- `proxies` — an object mapping a proxy **name** to its definition. Each
  definition takes a `url` (must start with `http://`, `https://`,
  `socks4://`, or `socks5://`) and optionally `username`/`password` for proxy
  authentication.
- `providers` — an object mapping a **provider id** to the name of a proxy from
  `proxies`. Each value may be the proxy name as a plain string (`"corp"`) or
  an object form such as `{ "proxy": "corp" }`; both are equivalent. A provider
  that is absent (or mapped to nothing) is not routed through a proxy.

Full example:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "./plugins/provider-proxy",
      "options": {
        "proxies": {
          "corp": {
            "url": "http://corp-proxy:8080"
          },
          "socks": {
            "url": "socks5://127.0.0.1:1080",
            "username": "user",
            "password": "secret"
          }
        },
        "providers": {
          "anthropic": { "proxy": "corp" },
          "openai": { "proxy": "socks" }
        }
      }
    }
  ]
}
```

With this config, Anthropic traffic goes through `corp` and OpenAI traffic
through `socks`. Any other provider keeps its normal direct connection.

## TUI panel and `/proxy-setup`

The plugin registers a TUI panel that shows every known provider and its current
proxy (or **Direct** when unset).

- Open the panel with the palette entry **Provider Proxy** (`Ctrl+G`) or with
  the slash command `/proxy-setup`.
- Click a provider row to change its proxy through a selection dialog that lists
  all configured proxies plus **Direct** (which clears the mapping).
- The panel edits the canonical config file via the plugin's RPC (`updateSettings`):
  the server writes the new mapping into `plugins[].options` and rebuilds the
  gateway, so the change is applied **without restarting** OpenCode.
- The panel keeps itself in sync with server-side changes by subscribing to the
  RPC `updated` event.
- Proxy credentials are never sent to the TUI — the panel only receives an
  `auth` boolean per proxy, so secrets never leave the server.

## Limitations

- **Discovery / OAuth / MCP traffic is not proxied.** The plugin only rewrites
  the `baseURL` of providers listed in `providers`. Service traffic that does not
  flow through those provider routes — MCP connectivity, OAuth token refresh,
  provider discovery (for example Azure deployments, Copilot model sync, Ollama
  probes) — uses the server's direct network.
- **WebSocket transport is disabled for selected providers.** Routed providers
  are forced to `transport: "http"`, so any WebSocket-based transport would
  bypass the gateway and is therefore not used for them.
- **Adding a new proxy from the panel is not supported.** The "Add proxy"
  dialog in the panel collects a URL and optional credentials but cannot persist
  a new proxy entry (the approved RPC contract only updates the provider→proxy
  mapping). It shows a warning toast instead. To add a proxy, edit the config
  file directly (see [Configuration](#configuration)); then the panel will offer
  the new proxy for selection.

## Manual smoke test

1. Configure the plugin as in [Configuration](#configuration), with a `proxy`
   you can observe (for example a mock CONNECT proxy) and a provider whose
   upstream you control.
2. Start OpenCode v2 in the project that loads the plugin.
3. Open the panel via `/proxy-setup` (or `Ctrl+G`).
4. In the panel, assign the test provider to your proxy, then clear it back to
   **Direct**. After each change, confirm:
   - `opencode.json(c)` was updated in `plugins[].options.providers`;
   - the change applied without restarting (a fresh request from that provider
     is routed through the proxy while mapped, and direct once cleared).

See `test/README.test.md` for the full manual verification checklist.
