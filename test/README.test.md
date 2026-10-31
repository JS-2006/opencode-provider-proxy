# Manual verification checklist — opencode-provider-proxy

This is a manual smoke test for the plugin. It verifies the plugin's behaviour
against the real OpenCode v2 runtime (not just the automated unit/integration
suite).

**Prereqs:** Node ≥ 20, an OpenCode v2 build that loads local plugins, and this
repository checked out on `feat/opencode-provider-proxy`.

---

## 1. Automated checks

Run from the repo root:

```bash
npm test
```

Expected: all test files pass (Vitest).

```bash
npm run typecheck
```

Expected: `tsc --noEmit` exits 0 with no output.

```bash
npm pack --dry-run
```

Expected: the tarball listing includes `package.json`, `README.md`, and the
`src/` files.

---

## 2. Start the mock CONNECT proxy and mock upstream

Create two throwaway Node scripts in a scratch directory (for example `/tmp/px-proxy/mock.js`).

**Mock upstream** (`mock-upstream.js`) — an HTTP server that records the requests
it receives:

```js
import http from "node:http"
http.createServer((req, res) => {
  console.log("UPSTREAM", req.method, req.url, req.headers.host)
  res.writeHead(200, { "content-type": "application/json" })
  res.end(JSON.stringify({ ok: true, url: req.url }))
}).listen(9101, "127.0.0.1", () => console.log("upstream on 9101"))
```

**Mock CONNECT proxy** (`mock-proxy.js`) — a TCP server that answers HTTP
CONNECT and tunnels bytes; it logs every CONNECT so you can confirm traffic went
through the proxy:

```js
import net from "node:net"
net.createServer((client) => {
  client.once("data", (buf) => {
    const line = buf.toString().split("\r\n")[0]
    console.log("PROXY CONNECT", line)
    const m = /^CONNECT ([^ ]+)/.exec(line)
    if (!m) return client.destroy()
    const [host, port] = m[1].split(":")
    const target = net.connect(Number(port), host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n")
      client.pipe(target).pipe(client)
    })
    target.on("error", () => client.destroy())
  })
}).listen(9100, "127.0.0.1", () => console.log("proxy on 9100"))
```

Run both in separate terminals:

```bash
node mock-upstream.js
node mock-proxy.js
```

---

## 3. Attach the plugin in a test `opencode.json`

Create a scratch OpenCode project that references the plugin by local path and
points the test provider at the mock upstream:

```jsonc
// <scratch>/opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "<path-to-this-repo>",
      "options": {
        "proxies": {
          "mock": { "url": "http://127.0.0.1:9100" }
        },
        "providers": {
          "openai": "mock"
        }
      }
    }
  ]
}
```

Use a provider whose upstream you can point at the mock upstream (for example a
custom provider whose `baseURL` is `http://127.0.0.1:9101/v1`). You can add a
local provider that reuses the `openai` id's route config, or set an existing
provider's `baseURL` to the mock upstream.

---

## 4. Launch OpenCode v2

From the scratch directory:

```bash
opencode
```

Open the plugin panel:

- Press `Ctrl+G`, or
- type the slash command `/proxy-setup`.

Expected: the **Provider Proxy** panel opens showing the configured provider with
its current proxy (`mock`) or **Direct**.

---

## 5. Verify editing writes to the config and applies without restart

1. In the panel, change the provider's mapping to **Direct**.
   - Expected: a success toast, and `opencode.json` `plugins[].options.providers`
     no longer maps that provider to `mock`.
   - Send a request through that provider: the mock **upstream** log shows the
     request and the mock **proxy** log shows **no** new CONNECT.
2. In the panel, change the provider's mapping back to `mock`.
   - Expected: `opencode.json` maps the provider to `mock` again.
   - Send a request through that provider: the mock **proxy** log now shows a new
     `CONNECT 127.0.0.1:9101` (or the upstream host), and the request is tunneled
     to the upstream.
   - The change applied **without restarting** OpenCode.
3. While the panel is open, edit `opencode.json` externally (for example add a
   second proxy or remap the provider) and save.
   - Expected: the panel refreshes to reflect the new state (via the `updated`
     event / config reload), no restart required.

---

## 6. Confirm the documented limitations

- **Add-proxy is not persisted.** In the panel, click **Add proxy**, fill in a
  URL, and confirm. Expected: a **warning** toast stating that adding a proxy
  through the panel is not yet supported; `opencode.json` is not modified.
- **Discovery/OAuth/MCP not proxied.** Traffic that is not a routed provider
  request (for example an MCP connection or OAuth flow) should not appear in the
  mock proxy log.
- **WebSocket disabled for selected providers.** A routed provider's settings
  are forced to `transport: "http"`.

---

## Pass criteria

All steps in sections 1, 4, and 5 behave as described, and the limitations in
section 6 behave as documented.
