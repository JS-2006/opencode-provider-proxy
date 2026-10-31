import { describe, expect, it } from "vitest"
import http from "node:http"
import net from "node:net"
import { createGateway } from "../src/gateway.js"
import { buildUpstreamUrl } from "../src/upstream.js"

interface UpstreamServer {
  port: number
  records: Array<{
    method: string
    path: string
    headers: http.IncomingHttpHeaders
    body: string
  }>
  stop(): Promise<void>
}

async function createUpstream(
  handler?: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<UpstreamServer> {
  const records: UpstreamServer["records"] = []
  const server = http.createServer((req, res) => {
    let body = ""
    req.on("data", (c) => (body += c))
    req.on("end", () => {
      records.push({ method: req.method ?? "", path: req.url ?? "", headers: req.headers, body })
      if (handler) {
        handler(req, res)
      } else {
        res.writeHead(200, { "content-type": "text/plain" })
        res.end("upstream-ok")
      }
    })
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()))
  const port = (server.address() as net.AddressInfo).port
  return {
    port,
    records,
    stop: () => new Promise<void>((r) => server.close(() => r())),
  }
}

interface ConnectProxy {
  port: number
  connects: string[]
  authHeaders: Array<string | null>
  stop(): Promise<void>
}

async function createConnectProxy(): Promise<ConnectProxy> {
  const connects: string[] = []
  const authHeaders: Array<string | null> = []
  const server = net.createServer((client) => {
    client.once("data", (d) => {
      const text = d.toString()
      connects.push(text)
      const m = /^CONNECT ([^ ]+) HTTP\/1\.1\r\n/.exec(text)
      const auth = /Proxy-Authorization:\s*([^\r\n]+)/i.exec(text)
      authHeaders.push(auth ? auth[1] : null)
      if (!m) {
        client.write("HTTP/1.1 400 Bad Request\r\n\r\n")
        client.end()
        return
      }
      const [host, port] = m[1].split(":")
      client.write("HTTP/1.1 200 Connection established\r\n\r\n")
      const target = net.connect(Number(port), host)
      client.pipe(target)
      target.pipe(client)
      target.on("error", () => client.destroy())
      client.on("error", () => target.destroy())
    })
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()))
  const port = (server.address() as net.AddressInfo).port
  return {
    port,
    connects,
    authHeaders,
    stop: () => new Promise<void>((r) => server.close(() => r())),
  }
}

interface Socks5Proxy {
  port: number
  stop(): Promise<void>
}

function createSocks5Proxy(): Promise<Socks5Proxy> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      let buf = Buffer.alloc(0)
      let stage = 0
      socket.on("data", (chunk) => {
        const chunkBuf = typeof chunk === "string" ? Buffer.from(chunk) : chunk
        buf = Buffer.concat([buf, chunkBuf])
        if (stage === 0) {
          if (buf.length < 2) return
          const nmethods = buf[1]
          if (buf.length < 2 + nmethods) return
          socket.write(Buffer.from([0x05, 0x00])) // greet, no-auth
          buf = buf.subarray(2 + nmethods)
          stage = 1
        }
        if (stage === 1) {
          if (buf.length < 4) return
          const atyp = buf[3]
          let addrLen: number
          if (atyp === 0x01) addrLen = 4
          else if (atyp === 0x04) addrLen = 16
          else if (atyp === 0x03) {
            if (buf.length < 5) return
            addrLen = buf[4] + 1
          } else {
            socket.destroy()
            return
          }
          const total = 4 + addrLen + 2
          if (buf.length < total) return
          let host: string
          if (atyp === 0x01) host = [...buf.subarray(4, 8)].join(".")
          else if (atyp === 0x04) host = [...buf.subarray(4, 20)].join(":")
          else host = buf.subarray(5, 5 + addrLen - 1).toString()
          const port = buf.readUInt16BE(total - 2)
          // success reply: 0x05 0x00 0x00 0x01 0.0.0.0:0
          socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
          const target = net.connect(port, host)
          socket.pipe(target)
          target.pipe(socket)
          target.on("error", () => socket.destroy())
          socket.on("error", () => target.destroy())
          stage = 2
        }
      })
    })
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port
      resolve({
        port,
        stop: () => new Promise<void>((r) => server.close(() => r())),
      })
    })
  })
}

async function closedPort(): Promise<number> {
  const srv = net.createServer()
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()))
  const port = (srv.address() as net.AddressInfo).port
  await new Promise<void>((r) => srv.close(() => r()))
  return port
}

describe("createGateway", () => {
  it("routes a direct request through a CONNECT proxy to the upstream", async () => {
    const upstream = await createUpstream()
    const proxy = await createConnectProxy()
    const gw = await createGateway({
      resolveUpstream: (pid, reqPath) =>
        pid === "anthropic"
          ? { url: buildUpstreamUrl(`http://127.0.0.1:${upstream.port}/v1`, pid, reqPath) }
          : undefined,
      getProxy: () => ({ url: `http://127.0.0.1:${proxy.port}` }),
    })
    try {
      const res = await fetch(`http://127.0.0.1:${gw.port}/anthropic/v1/messages`, {
        method: "POST",
        body: JSON.stringify({ model: "x" }),
      })
      expect(res.status).toBe(200)
      expect(await res.text()).toBe("upstream-ok")
      expect(proxy.connects).toHaveLength(1)
      expect(upstream.records).toHaveLength(1)
      expect(upstream.records[0].path).toBe("/v1/messages")
      expect(upstream.records[0].headers.host).toBe(`127.0.0.1:${upstream.port}`)
    } finally {
      await gw.close()
      await proxy.stop()
      await upstream.stop()
    }
  })

  it("sends Proxy-Authorization Basic on CONNECT when credentials are configured", async () => {
    const upstream = await createUpstream()
    const proxy = await createConnectProxy()
    const gw = await createGateway({
      resolveUpstream: () => ({ url: buildUpstreamUrl(`http://127.0.0.1:${upstream.port}/v1`, "anthropic", "/anthropic/v1/messages") }),
      getProxy: () => ({
        url: `http://127.0.0.1:${proxy.port}`,
        username: "u",
        password: "p",
      }),
    })
    try {
      const res = await fetch(`http://127.0.0.1:${gw.port}/anthropic/v1/messages`)
      expect(res.status).toBe(200)
      expect(proxy.authHeaders[0]).toBe("Basic dTpw")
    } finally {
      await gw.close()
      await proxy.stop()
      await upstream.stop()
    }
  })

  it("streams the response body chunk-by-chunk before upstream closes", async () => {
    const upstream = await createUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" })
      res.write("chunk-1")
      setTimeout(() => {
        res.write("chunk-2")
        res.end()
      }, 100)
    })
    const proxy = await createConnectProxy()
    const gw = await createGateway({
      resolveUpstream: () => ({ url: buildUpstreamUrl(`http://127.0.0.1:${upstream.port}/v1`, "anthropic", "/anthropic/v1/messages") }),
      getProxy: () => ({ url: `http://127.0.0.1:${proxy.port}` }),
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const start = Date.now()
        const chunks: string[] = []
        let firstTime = -1
        const req = http.get(`http://127.0.0.1:${gw.port}/anthropic/v1/messages`, (res) => {
          res.on("data", (c) => {
            if (firstTime < 0) firstTime = Date.now() - start
            chunks.push(c.toString())
          })
          res.on("end", () => {
            try {
              expect(firstTime).toBeGreaterThanOrEqual(0)
              expect(firstTime).toBeLessThanOrEqual(60)
              expect(chunks.join("")).toBe("chunk-1chunk-2")
              resolve()
            } catch (e) {
              reject(e)
            }
          })
        })
        req.on("error", reject)
      })
    } finally {
      await gw.close()
      await proxy.stop()
      await upstream.stop()
    }
  })

  it("returns 502 with JSON error when the proxy refuses the connection", async () => {
    const upstream = await createUpstream()
    const dead = await closedPort()
    const gw = await createGateway({
      resolveUpstream: () => ({ url: buildUpstreamUrl(`http://127.0.0.1:${upstream.port}/v1`, "anthropic", "/anthropic/v1/messages") }),
      getProxy: () => ({ url: `http://127.0.0.1:${dead}` }),
    })
    try {
      const res = await fetch(`http://127.0.0.1:${gw.port}/anthropic/v1/messages`)
      expect(res.status).toBe(502)
      const body = (await res.json()) as { error: string; message: string }
      expect(body.error).toBe("proxy_error")
      expect(typeof body.message).toBe("string")
      expect(body.message.length).toBeGreaterThan(0)
    } finally {
      await gw.close()
      await upstream.stop()
    }
  })

  it("returns 404 for unknown providers and malformed provider paths", async () => {
    const upstream = await createUpstream()
    const proxy = await createConnectProxy()
    const gw = await createGateway({
      resolveUpstream: (pid, reqPath) =>
        pid === "anthropic"
          ? { url: buildUpstreamUrl(`http://127.0.0.1:${upstream.port}/v1`, pid, reqPath) }
          : undefined,
      getProxy: () => ({ url: `http://127.0.0.1:${proxy.port}` }),
    })
    try {
      const res = await fetch(`http://127.0.0.1:${gw.port}/unknown/v1/messages`)
      expect(res.status).toBe(404)
      const noSlash = await fetch(`http://127.0.0.1:${gw.port}/anthropic`)
      expect(noSlash.status).toBe(404)
    } finally {
      await gw.close()
      await proxy.stop()
      await upstream.stop()
    }
  })

  it("routes through a SOCKS5 proxy", async () => {
    const upstream = await createUpstream()
    const socks = await createSocks5Proxy()
    const gw = await createGateway({
      resolveUpstream: () => ({ url: buildUpstreamUrl(`http://127.0.0.1:${upstream.port}/v1`, "anthropic", "/anthropic/v1/messages") }),
      getProxy: () => ({ url: `socks5://127.0.0.1:${socks.port}` }),
    })
    try {
      const res = await fetch(`http://127.0.0.1:${gw.port}/anthropic/v1/messages`)
      expect(res.status).toBe(200)
      expect(await res.text()).toBe("upstream-ok")
    } finally {
      await gw.close()
      await socks.stop()
      await upstream.stop()
    }
  })
})
