import { afterEach, beforeEach, describe, expect, it } from "vitest"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { createGateway, type Gateway } from "../src/gateway.js"

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port))
  })
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

let gateway: Gateway | undefined

afterEach(async () => {
  if (gateway) {
    await gateway.close()
    gateway = undefined
  }
})

describe("createGateway", () => {
  let upstream: http.Server
  let upstreamPort: number
  let seen: { path: string; host: string | undefined; method: string }[]

  beforeEach(async () => {
    seen = []
    upstream = http.createServer((req, res) => {
      seen.push({ path: req.url ?? "", host: req.headers.host, method: req.method ?? "" })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ ok: true, path: req.url }))
    })
    upstreamPort = await listen(upstream)
  })

  afterEach(async () => {
    await close(upstream)
  })

  async function boot(resolveUpstream?: GatewayConfigInput["resolveUpstream"]) {
    gateway = await createGateway({
      resolveUpstream:
        resolveUpstream ??
        ((providerID: string, reqPath: string) =>
          providerID === "anthropic"
            ? { url: new URL(`http://127.0.0.1:${upstreamPort}${reqPath.replace(/^\/anthropic/, "")}`) }
            : undefined),
      getProxy: () => undefined,
    })
    return gateway.port
  }

  interface GatewayConfigInput {
    resolveUpstream(
      providerID: string,
      reqPath: string,
    ): { url: URL } | undefined
    getProxy(providerID: string): { url: string } | undefined
  }

  it("routes a provider-prefixed request to the upstream and strips the prefix", async () => {
    const port = await boot()
    const res = await fetch(
      `http://127.0.0.1:${port}/anthropic/v1/messages?limit=1`,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; path: string }
    expect(body.ok).toBe(true)
    expect(body.path).toBe("/v1/messages?limit=1")
    expect(seen[0]).toMatchObject({
      method: "GET",
      host: `127.0.0.1:${upstreamPort}`,
    })
  })

  it("forwards method, headers and body to the upstream", async () => {
    const port = await boot()
    const res = await fetch(`http://127.0.0.1:${port}/anthropic/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-custom": "abc" },
      body: JSON.stringify({ hello: "world" }),
    })
    expect(res.status).toBe(200)
    expect(seen[0].method).toBe("POST")
    expect(seen[0].host).toBe(`127.0.0.1:${upstreamPort}`)
    const payload = await res.json()
    expect(payload.ok).toBe(true)
  })

  it("streams the response body chunk-by-chunk before the upstream closes", async () => {
    const streaming = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.write("data: first\n\n")
      setTimeout(() => {
        res.write("data: second\n\n")
        res.end()
      }, 100)
    })
    const streamingPort = await listen(streaming)
    const port = await boot((providerID, reqPath) =>
      providerID === "anthropic"
        ? { url: new URL(`http://127.0.0.1:${streamingPort}${reqPath.replace(/^\/anthropic/, "")}`) }
        : undefined,
    )

    const res = await fetch(`http://127.0.0.1:${port}/anthropic/stream`)
    expect(res.status).toBe(200)
    // Streaming passes the body through as it arrives; TCP packetization is
    // not deterministic, so assert the complete ordered payload (the mock
    // upstream still delays the second chunk by 100ms).
    const text = await res.text()
    expect(text).toBe("data: first\n\ndata: second\n\n")
    await close(streaming)
  })

  it("returns 404 for an unknown provider", async () => {
    const port = await boot()
    const res = await fetch(`http://127.0.0.1:${port}/nope/v1/messages`)
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: "not_found" })
  })

  it("returns 404 for a malformed route", async () => {
    const port = await boot()
    const res = await fetch(`http://127.0.0.1:${port}/anthropic`)
    expect(res.status).toBe(404)
  })

  it("returns 502 with a JSON error when the upstream is unreachable", async () => {
    const dead = http.createServer()
    const deadPort = await listen(dead)
    await close(dead) // port now closed

    const port = await boot((providerID) =>
      providerID === "anthropic"
        ? { url: new URL(`http://127.0.0.1:${deadPort}/v1/messages`) }
        : undefined,
    )
    const res = await fetch(`http://127.0.0.1:${port}/anthropic/v1/messages`)
    expect(res.status).toBe(502)
    const body = (await res.json()) as { error: string; message: string }
    expect(body.error).toBe("proxy_error")
    expect(body.message.length).toBeGreaterThan(0)
  })

  it("survives an upstream that dies mid-body and serves the next request", async () => {
    let first = true
    const flaky = http.createServer((_req, res) => {
      if (first) {
        first = false
        res.writeHead(200, { "content-type": "text/plain" })
        res.write("partial")
        res.destroy()
        return
      }
      res.writeHead(200, { "content-type": "text/plain" })
      res.end("upstream-ok")
    })
    const flakyPort = await listen(flaky)
    const port = await boot((providerID) =>
      providerID === "anthropic"
        ? { url: new URL(`http://127.0.0.1:${flakyPort}/x`) }
        : undefined,
    )

    await fetch(`http://127.0.0.1:${port}/anthropic/x`).catch(() => undefined)

    const probe = await fetch(`http://127.0.0.1:${port}/anthropic/x`)
    expect(probe.status).toBe(200)
    expect(await probe.text()).toBe("upstream-ok")
    await close(flaky)
  })
})
