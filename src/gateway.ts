import http from "node:http"
import type { Agent } from "node:http"
import { HttpsProxyAgent } from "https-proxy-agent"
import { SocksProxyAgent } from "socks-proxy-agent"
import type { ProxyTarget } from "./config.js"

export interface GatewayConfig {
  /** Resolve a provider-prefixed request path to an upstream URL. */
  resolveUpstream(providerID: string, reqPath: string): { url: URL } | undefined
  /** Return the proxy target for a provider, or undefined for a direct route. */
  getProxy(providerID: string): ProxyTarget | undefined
}

export interface Gateway {
  port: number
  close(): Promise<void>
}

// Accept only a well-formed `/${providerID}/…` path. Requiring the trailing slash
// (and forbidding slashes inside the provider id) keeps the prefix check from
// matching e.g. `/anthropicXYZ/…` as provider `anthropic`.
const ROUTE_RE = /^\/([^/]+)\//

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
])

function buildAgent(target: ProxyTarget): Agent {
  const u = new URL(target.url)
  // Embed credentials in the proxy URL so the underlying agents inject them:
  // - HttpsProxyAgent sends `Proxy-Authorization: Basic …` on CONNECT.
  // - SocksProxyAgent uses them for SOCKS authentication.
  if (target.username !== undefined) u.username = target.username
  if (target.password !== undefined) u.password = target.password
  const scheme = u.protocol.replace(":", "")
  if (scheme === "http" || scheme === "https") {
    // HttpsProxyAgent always tunnels via CONNECT (for both http and https
    // destinations), which is what the CONNECT-proxy path requires. The plain
    // HttpProxyAgent the top-level ProxyAgent would select for an http upstream
    // uses absolute-form proxying instead of CONNECT.
    return new HttpsProxyAgent(u.href)
  }
  return new SocksProxyAgent(u.href)
}

function stripCredentials(message: string): string {
  return message.replace(/\/\/[^/@\s]*@/g, "//")
}

export async function createGateway(cfg: GatewayConfig): Promise<Gateway> {
  const agents = new Map<string, Agent>()

  const server = http.createServer((req, res) => {
    void handle(req, res)
  })

  function respondNotFound(res: http.ServerResponse): void {
    if (!res.headersSent) {
      res.writeHead(404, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: "not_found", message: "unknown provider" }))
    } else {
      res.destroy()
    }
  }

  function respondProxyError(res: http.ServerResponse, err: unknown): void {
    if (res.headersSent) {
      res.destroy()
      return
    }
    const raw = err instanceof Error ? err.message : String(err)
    res.writeHead(502, { "content-type": "application/json" })
    res.end(
      JSON.stringify({
        error: "proxy_error",
        message: stripCredentials(raw),
      }),
    )
  }

  async function handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      await handleInner(req, res)
    } catch (err) {
      respondProxyError(res, err)
    }
  }

  async function handleInner(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const match = ROUTE_RE.exec(req.url ?? "")
    if (!match) {
      respondNotFound(res)
      return
    }
    const providerID = match[1]

    const resolved = cfg.resolveUpstream(providerID, req.url ?? "")
    if (!resolved) {
      respondNotFound(res)
      return
    }
    const upstream = resolved.url

    let agent: Agent | undefined
    const proxyTarget = cfg.getProxy(providerID)
    if (proxyTarget) {
      // Key the agent cache by the full proxy identity (URL plus credentials)
      // so two providers sharing the same proxy reuse one agent, while agents
      // for different targets are never reused.
      const cacheKey = `${proxyTarget.url}#${proxyTarget.username ?? ""}#${proxyTarget.password ?? ""}`
      let cached = agents.get(cacheKey)
      if (!cached) {
        cached = buildAgent(proxyTarget)
        agents.set(cacheKey, cached)
      }
      agent = cached
    }

    const headers: http.OutgoingHttpHeaders = {}
    for (const [key, value] of Object.entries(req.headers)) {
      if (key === "host" || key === "connection") continue
      if (value === undefined) continue
      headers[key] = value
    }
    for (const name of HOP_BY_HOP) delete headers[name]
    headers.Host = upstream.host

    const upstreamReq = http.request(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port ? Number(upstream.port) : upstream.protocol === "https:" ? 443 : 80,
        method: req.method ?? "GET",
        path: upstream.pathname + upstream.search,
        headers,
        agent,
      },
      (upstreamRes) => {
        const resHeaders: http.OutgoingHttpHeaders = {}
        for (const [key, value] of Object.entries(upstreamRes.headers)) {
          if (HOP_BY_HOP.has(key)) continue
          if (value === undefined) continue
          resHeaders[key] = value
        }
        res.writeHead(upstreamRes.statusCode ?? 502, resHeaders)
        upstreamRes.on("error", () => res.destroy())
        upstreamRes.pipe(res)
      },
    )

    upstreamReq.on("error", (err) => respondProxyError(res, err))
    res.on("close", () => {
      if (!res.writableEnded) upstreamReq.destroy()
    })

    req.pipe(upstreamReq)
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })

  const port = (server.address() as { port: number }).port

  return {
    port,
    close: async () => {
      for (const agent of agents.values()) agent.destroy()
      agents.clear()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
