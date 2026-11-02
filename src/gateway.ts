/**
 * opencode-provider-proxy
 * Copyright (C) 2026 The opencode-provider-proxy contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import net from "node:net"
import tls from "node:tls"
import { spawn, type ChildProcess } from "node:child_process"
import http from "node:http"
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

const REQUEST_BODY_LIMIT = 128 * 1024 * 1024 // 128 MiB

function stripCredentials(message: string): string {
  return message.replace(/\/\/[^/@\s]*@/g, "//")
}

// ---------------------------------------------------------------------------
// Wire: a single buffered data source over a socket. Every phase (handshake,
// response head, body streaming) reads from the same stash, so no byte is
// ever lost between phases. This is the key difference from naive per-phase
// listeners.
// ---------------------------------------------------------------------------

interface Waiter {
  kind: "avail" | "bytes" | "marker"
  n?: number
  marker?: string
  limit?: number
  resolve(b: Buffer | null): void
  reject(e: Error): void
}

class Wire {
  private readonly sock: DuplexLike
  private stash = Buffer.alloc(0)
  private ended = false
  private err: Error | undefined
  private waiters: Waiter[] = []

  constructor(sock: DuplexLike) {
    this.sock = sock
    sock.on("data", (chunk: Buffer) => {
      this.stash = Buffer.concat([this.stash, chunk])
      this.drain()
    })
    sock.on("end", () => {
      this.ended = true
      this.drain()
    })
    sock.on("error", (e: Error) => {
      this.err = e
      this.drain()
    })
  }
  destroy(): void {
    this.sock.destroy()
  }

  private drain(): void {
    while (this.waiters.length > 0) {
      const w = this.waiters[0]
      if (w.kind === "avail") {
        if (this.stash.length > 0) {
          this.waiters.shift()
          const b = this.stash
          this.stash = Buffer.alloc(0)
          w.resolve(b)
        } else if (this.err) {
          this.waiters.shift()
          w.reject(this.err)
        } else if (this.ended) {
          this.waiters.shift()
          w.resolve(null)
        } else break
      } else if (w.kind === "bytes") {
        const n = w.n ?? 0
        if (this.stash.length >= n) {
          const b = this.stash.subarray(0, n)
          this.stash = this.stash.subarray(n)
          this.waiters.shift()
          w.resolve(b)
        } else if (this.err) {
          this.waiters.shift()
          w.reject(this.err)
        } else if (this.ended) {
          this.waiters.shift()
          w.reject(new Error("socket closed"))
        } else break
      } else {
        const marker = Buffer.from(w.marker ?? "\r\n\r\n", "latin1")
        const i = this.stash.indexOf(marker)
        if (i >= 0) {
          const end = i + marker.length
          const b = this.stash.subarray(0, end)
          this.stash = this.stash.subarray(end)
          this.waiters.shift()
          w.resolve(b)
        } else if (this.err) {
          this.waiters.shift()
          w.reject(this.err)
        } else if (this.ended || this.stash.length > (w.limit ?? 1024 * 1024)) {
          this.waiters.shift()
          w.reject(new Error("marker not found"))
        } else break
      }
    }
  }

  readAvailable(): Promise<Buffer | null> {
    return new Promise((resolve, reject) => {
      this.waiters.push({ kind: "avail", resolve, reject })
    })
  }

  waitBytes(n: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      this.waiters.push({
        kind: "bytes",
        n,
        resolve: resolve as (b: Buffer | null) => void,
        reject,
      })
    })
  }

  waitMarker(marker: string, limit: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      this.waiters.push({
        kind: "marker",
        marker,
        limit,
        resolve: resolve as (b: Buffer | null) => void,
        reject,
      })
    })
  }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/**
 * One-shot handshake reader: accumulates bytes and resolves `n`-byte or
 * marker-terminated reads exactly once. Detach before handing the socket over
 * to a Wire.
 */
function makeHandshakeReader(sock: net.Socket) {
  let buf = Buffer.alloc(0)
  const waiters: Array<
    | { kind: "n"; n: number; res(b: Buffer): void; rej(e: Error): void }
    | { kind: "marker"; marker: string; limit: number; res(b: Buffer): void; rej(e: Error): void }
  > = []
  const onData = (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk])
    flush()
  }
  const onError = (e: Error) => {
    for (const w of waiters.splice(0)) w.rej(e)
  }
  function flush(): void {
    while (waiters.length > 0) {
      const w = waiters[0]
      if (w.kind === "n") {
        if (buf.length >= w.n) {
          const out = buf.subarray(0, w.n)
          buf = buf.subarray(w.n)
          waiters.shift()
          w.res(out)
        } else break
      } else {
        const i = buf.indexOf(Buffer.from(w.marker, "latin1"))
        if (i >= 0) {
          const end = i + w.marker.length
          const out = buf.subarray(0, end)
          buf = buf.subarray(end)
          waiters.shift()
          w.res(out)
        } else if (buf.length > w.limit) {
          waiters.shift()
          w.rej(new Error("handshake response too large"))
        } else break
      }
    }
  }
  sock.on("data", onData)
  sock.on("error", onError)
  return {
    n(n: number): Promise<Buffer> {
      return new Promise((res, rej) => waiters.push({ kind: "n", n, res, rej }))
    },
    marker(marker: string, limit: number): Promise<Buffer> {
      return new Promise((res, rej) => waiters.push({ kind: "marker", marker, limit, res, rej }))
    },
    detach(): void {
      sock.off("data", onData)
      sock.off("error", onError)
    },
  }
}

interface ProxyEndpoint {
  scheme: "http" | "socks5"
  host: string
  port: number
  username?: string
  password?: string
}

function parseProxy(target: ProxyTarget): ProxyEndpoint {
  const u = new URL(target.url)
  const scheme = u.protocol.replace(":", "")
  if (scheme !== "http" && scheme !== "socks5" && scheme !== "socks4") {
    throw new Error(`unsupported proxy scheme "${scheme}"`)
  }
  if (scheme === "socks4") {
    // SOCKS4 (no auth) is handled by the SOCKS5 no-auth handshake framing.
    return { scheme: "socks5", host: u.hostname, port: Number(u.port || 1080) }
  }
  return {
    scheme: scheme as "http" | "socks5",
    host: u.hostname,
    port: Number(u.port || (scheme === "http" ? 80 : 1080)),
    username: target.username,
    password: target.password,
  }
}

function connectTcp(host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port })
    sock.once("connect", () => resolve(sock))
    sock.once("error", reject)
  })
}

interface DuplexLike {
  on(event: "data", cb: (chunk: Buffer) => void): unknown
  on(event: "end", cb: () => void): unknown
  on(event: "error", cb: (e: Error) => void): unknown
  write(buf: Uint8Array | string): unknown
  destroy(): void
}

/**
 * Bun's `tls.connect({ socket })` does not reliably do TLS over an
 * established CONNECT tunnel. For HTTPS destinations reached through a proxy
 * we delegate the CONNECT+TLS handshake to `openssl s_client -proxy`, which
 * works consistently, and expose its stdio pair as a Duplex-like socket.
 */
function spawnTlsViaProxy(
  host: string,
  port: number,
  proxy: ProxyEndpoint,
): { child: ChildProcess; sock: DuplexLike } {
  const child = spawn(
    "openssl",
    [
      "s_client",
      "-connect",
      `${host}:${port}`,
      "-proxy",
      `${proxy.host}:${proxy.port}`,
      "-servername",
      host,
      "-verify_return_error",
      "-verify_hostname",
      host,
      "-quiet",
      "-ign_eof",
    ],
    { stdio: ["pipe", "pipe", "ignore"] },
  )
  const sock: DuplexLike = {
    on(event, cb) {
      if (event === "data") child.stdout?.on("data", cb as (d: Buffer) => void)
      else if (event === "end") child.stdout?.on("end", cb as () => void)
      else if (event === "error") {
        child.stdout?.on("error", cb as (e: Error) => void)
        child.on("error", cb as (e: Error) => void)
      }
      return this
    },
    write(buf) {
      return child.stdin?.write(buf)
    },
    destroy() {
      try {
        child.kill("SIGKILL")
      } catch {
        /* already gone */
      }
    },
  }
  return { child, sock }
}

function readResponseHead(buf: Buffer): { status: number; headers: Map<string, string> } {
  const head = buf.toString("latin1")
  const lines = head.split("\r\n")
  const statusLine = lines.shift() ?? ""
  const match = /^HTTP\/1\.[01] (\d{3})/.exec(statusLine)
  if (!match) throw new Error(`bad upstream status line: ${statusLine.slice(0, 80)}`)
  const headers = new Map<string, string>()
  for (const line of lines) {
    const ci = line.indexOf(":")
    if (ci === -1) continue
    headers.set(line.slice(0, ci).trim().toLowerCase(), line.slice(ci + 1).trim())
  }
  return { status: Number(match[1]), headers }
}

/**
 * Open a duplex connection to `host:port`, going through `proxy` when given.
 * Returns a Wire over the final socket (already TLS-wrapped for https).
 */
async function openWire(
  host: string,
  port: number,
  useTls: boolean,
  proxy?: ProxyEndpoint,
): Promise<{ wire: Wire; destroy(): void; sock: DuplexLike }> {
  if (!proxy) {
    if (useTls) {
      // Direct TLS: no socket reuse, works under Bun.
      const sock = tls.connect({ host, port, servername: host })
      await new Promise<void>((resolve, reject) => {
        sock.once("secureConnect", resolve)
        sock.once("error", reject)
      })
      return { wire: new Wire(sock), destroy: () => sock.destroy(), sock }
    }
    const sock = await connectTcp(host, port)
    return { wire: new Wire(sock), destroy: () => sock.destroy(), sock }
  }

  if (useTls) {
    // Bun cannot layer tls.connect over an existing socket, so delegate the
    // whole CONNECT + TLS handshake to openssl. This must happen before any
    // manual CONNECT, otherwise openssl would open a second tunnel and the
    // first socket would leak.
    if (proxy.scheme !== "http") {
      throw new Error("https through a SOCKS proxy is not supported")
    }
    const { sock: tlssock, child } = spawnTlsViaProxy(host, port, proxy)
    return { wire: new Wire(tlssock), destroy: () => child.kill("SIGKILL"), sock: tlssock }
  }

  const proxySock = await connectTcp(proxy.host, proxy.port)
  const hs = makeHandshakeReader(proxySock)

  if (proxy.scheme === "http") {
    const authority = port === (useTls ? 443 : 80) ? host : `${host}:${port}`
    let req = `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nConnection: close\r\n`
    if (proxy.username !== undefined) {
      const creds = Buffer.from(`${proxy.username}:${proxy.password ?? ""}`, "utf8").toString("base64")
      req += `Proxy-Authorization: Basic ${creds}\r\n`
    }
    req += "\r\n"
    proxySock.write(req)
    const headBuf = await hs.marker("\r\n\r\n", 64 * 1024)
    const parsed = readResponseHead(headBuf)
    if (parsed.status !== 200) {
      hs.detach()
      proxySock.destroy()
      throw new Error(`proxy CONNECT failed with status ${parsed.status}`)
    }
    hs.detach()
    return { wire: new Wire(proxySock), destroy: () => proxySock.destroy(), sock: proxySock }
  }

  // SOCKS5
  const methods = proxy.username !== undefined ? [0x02, 0x00] : [0x00]
  proxySock.write(Buffer.from([0x05, methods.length, ...methods]))
  const greet = await hs.n(2)
  if (greet[0] !== 0x05) throw new Error("socks5: bad greeting version")
  if (greet[1] === 0xff) throw new Error("socks5: no acceptable auth method")
  if (greet[1] === 0x02) {
    const user = Buffer.from(proxy.username ?? "", "utf8")
    const pass = Buffer.from(proxy.password ?? "", "utf8")
    if (user.length > 255 || pass.length > 255) throw new Error("socks5: credentials too long")
    proxySock.write(
      Buffer.concat([
        Buffer.from([0x01, user.length]),
        user,
        Buffer.from([pass.length]),
        pass,
      ]),
    )
    const authReply = await hs.n(2)
    if (authReply[1] !== 0x00) throw new Error("socks5: auth failed")
  }

  const hostBuf = Buffer.from(host, "utf8")
  let atyp = 0x03
  let addrBuf = Buffer.concat([Buffer.from([hostBuf.length]), hostBuf])
  if (net.isIPv4(host)) {
    atyp = 0x01
    addrBuf = Buffer.from(host.split(".").map(Number))
  } else if (net.isIPv6(host)) {
    atyp = 0x04
    const bytes: number[] = []
    for (const part of host.split(":")) {
      const hex = part.padStart(4, "0")
      bytes.push(parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2), 16))
    }
    addrBuf = Buffer.from(bytes)
  }
  proxySock.write(
    Buffer.concat([
      Buffer.from([0x05, 0x01, 0x00, atyp]),
      addrBuf,
      Buffer.from([(port >> 8) & 0xff, port & 0xff]),
    ]),
  )
  const connectReply = await hs.n(4)
  if (connectReply[0] !== 0x05 || connectReply[1] !== 0x00) {
    hs.detach()
    proxySock.destroy()
    throw new Error(`socks5: connect failed (rep=${connectReply[1]})`)
  }
  const atype = connectReply[3]
  if (atype === 0x01) await hs.n(4)
  else if (atype === 0x04) await hs.n(16)
  else if (atype === 0x03) {
    const len = (await hs.n(1))[0]
    await hs.n(len)
  } else throw new Error(`socks5: bad bound address type ${atype}`)
  await hs.n(2)
  hs.detach()

  return { wire: new Wire(proxySock), destroy: () => proxySock.destroy(), sock: proxySock }
}

// ---------------------------------------------------------------------------
// Raw HTTP exchange
// ---------------------------------------------------------------------------

function createChunkDecoder(emit: (d: Buffer) => void) {
  let buf = Buffer.alloc(0)
  let size = -1
  let state: "size" | "data" | "crlf" | "done" = "size"
  return {
    done: false,
    feed(input: Buffer): void {
      if (this.done) return
      buf = Buffer.concat([buf, input])
      for (;;) {
        if (state === "size") {
          const nl = buf.indexOf("\r\n")
          if (nl === -1) return
          const line = buf.subarray(0, nl).toString("latin1").trim()
          buf = buf.subarray(nl + 2)
          const parsed = parseInt(line, 16)
          if (Number.isNaN(parsed) || parsed < 0) {
            state = "done"
            this.done = true
            return
          }
          if (parsed === 0) {
            state = "done"
            this.done = true
            const nl2 = buf.indexOf("\r\n")
            if (nl2 !== -1) buf = buf.subarray(nl2 + 2)
            return
          }
          size = parsed
          state = "data"
        } else if (state === "data") {
          if (buf.length < size) return
          emit(buf.subarray(0, size))
          buf = buf.subarray(size)
          state = "crlf"
        } else if (state === "crlf") {
          if (buf.length < 2) return
          if (buf[0] === 0x0d && buf[1] === 0x0a) {
            buf = buf.subarray(2)
            state = "size"
          } else {
            state = "done"
            this.done = true
            return
          }
        } else return
      }
    },
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_resolve, reject) => {
      setTimeout(() => reject(new Error(msg)), ms)
    }),
  ])
}

/** Resolve with null when idle timeout elapses (used for unframed bodies). */
function withIdle<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    p.then((v) => (v === null ? null : v)),
    new Promise<T | null>((resolve) => {
      setTimeout(() => resolve(null), ms)
    }),
  ])
}

async function readUpstreamBody(
  wire: Wire,
  headers: Map<string, string>,
  onChunk: (d: Buffer) => void,
): Promise<void> {
  const te = headers.get("transfer-encoding")?.toLowerCase()
  if (te && te.includes("chunked")) {
    const decoder = createChunkDecoder(onChunk)
    for (;;) {
      const chunk = await wire.readAvailable()
      if (chunk === null) return
      decoder.feed(chunk)
      if (decoder.done) return
    }
  }
  const cl = headers.get("content-length")
  if (cl !== undefined) {
    let remaining = Number(cl)
    while (remaining > 0) {
      const chunk = await withTimeout(wire.readAvailable(), 120_000, "upstream body timeout")
      if (chunk === null) throw new Error("upstream closed before body completed")
      if (chunk.length > remaining) {
        onChunk(chunk.subarray(0, remaining))
        return
      }
      onChunk(chunk)
      remaining -= chunk.length
    }
    return
  }
  for (;;) {
    // No Content-Length / Transfer-Encoding: body runs until EOF. Some hosts
    // keep the connection open without announcing framing, so end the response
    // after a short idle period instead of hanging forever.
    const chunk = await withIdle(wire.readAvailable(), 2000)
    if (chunk === null) return
    onChunk(chunk)
  }
}

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

export async function createGateway(cfg: GatewayConfig): Promise<Gateway> {
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

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      await handleInner(req, res)
    } catch (err) {
      respondProxyError(res, err)
    }
  }

  async function handleInner(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
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

    const bodyParts: Buffer[] = []
    let bodySize = 0
    for await (const chunk of req) {
      bodySize += chunk.length
      if (bodySize > REQUEST_BODY_LIMIT) throw new Error("request body too large")
      bodyParts.push(chunk)
    }
    const body = Buffer.concat(bodyParts)

    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(req.headers)) {
      if (key === "host" || key === "connection") continue
      if (value === undefined) continue
      if (HOP_BY_HOP.has(key)) continue
      if (key === "content-length" || key === "transfer-encoding") continue
      headers[key] = Array.isArray(value) ? value.join("; ") : String(value)
    }

    const host = upstream.hostname
    const port = upstream.port ? Number(upstream.port) : upstream.protocol === "https:" ? 443 : 80
    const useTls = upstream.protocol === "https:"
    const proxyTarget = cfg.getProxy(providerID)
    const proxy = proxyTarget ? parseProxy(proxyTarget) : undefined

    const opened = await openWire(host, port, useTls, proxy)
    const { wire, destroy, sock } = opened
    try {
      const headLines: string[] = [
        `${req.method ?? "GET"} ${upstream.pathname + upstream.search} HTTP/1.1`,
      ]
      let hasHost = false
      for (const [key, value] of Object.entries(headers)) {
        if (key === "host") {
          hasHost = true
          headLines.push(`Host: ${upstream.host}`)
        } else {
          headLines.push(`${key}: ${value}`)
        }
      }
      if (!hasHost) headLines.push(`Host: ${upstream.host}`)
      headLines.push("Connection: close")
      headLines.push(`Content-Length: ${body.length}`)
      headLines.push("")

      if (typeof (sock as { setTimeout?: unknown }).setTimeout === "function") {
        ;(sock as unknown as { setTimeout(ms: number, fn: () => void): void }).setTimeout(120_000, () => {
          ;(sock as { destroy?(e?: Error): void }).destroy?.(new Error("upstream timeout"))
        })
      }
      sock.write(headLines.join("\r\n") + "\r\n")
      if (body.length > 0) sock.write(body)

      const headBuf = await wire.waitMarker("\r\n\r\n", 1024 * 1024)
      const parsed = readResponseHead(headBuf)

      const outHeaders: http.OutgoingHttpHeaders = {}
      for (const [key, value] of parsed.headers) {
        if (HOP_BY_HOP.has(key)) continue
        outHeaders[key] = value
      }
      res.writeHead(parsed.status, outHeaders)

      await readUpstreamBody(wire, parsed.headers, (chunk) => {
        if (res.destroyed) return
        res.write(Buffer.from(chunk))
      })
      if (!res.writableEnded) res.end()
    } finally {
      destroy()
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })

  const port = (server.address() as { port: number }).port

  return {
    port,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
