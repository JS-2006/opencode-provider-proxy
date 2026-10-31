import { describe, expect, it, vi } from "vitest"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import plugin from "../src/index.js"

interface ProviderShape {
  id: string
  settings?: { baseURL?: string }
}

interface FakeGateway {
  port: number
  closed: boolean
  close: () => Promise<void>
}

// Shared mutable state visible to the hoisted vi.mock factory.
const state = vi.hoisted(() => ({
  gateways: [] as FakeGateway[],
}))

// Stub the gateway so we can observe instance lifecycle (create/close) without
// binding real sockets. The route/proxy selection closures are what we want to
// prove reflect fresh state, so a fake port is enough.
vi.mock("../src/gateway.js", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("../src/gateway.js")
  return {
    ...actual,
    createGateway: vi.fn(
      async (): Promise<ReturnType<typeof actual.createGateway>> => {
        const gw: FakeGateway = {
          port: 5100 + state.gateways.length,
          closed: false,
          close: async () => {
            gw.closed = true
          },
        }
        state.gateways.push(gw)
        return gw
      },
    ),
  }
})

interface Handlers {
  getSettings(): Promise<{
    active: boolean
    providers: Array<{ id: string; proxy: string | null }>
  }>
  updateSettings(input: { providers: Record<string, string | null> }): Promise<{
    ok: boolean
  }>
}

async function boot(options: unknown, providers: ProviderShape[]) {
  state.gateways.length = 0
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "proxy-lifecycle-"))
  await fs.writeFile(
    path.join(dir, "opencode.json"),
    JSON.stringify({
      plugins: [{ package: "opencode-provider-proxy", options }],
    }),
    "utf8",
  )

  let failNextTransform = false
  const emitted: Array<[string, unknown]> = []

  // The plugin mutates `transform`/`rpc`/`event` against a live ctx. We mock
  // just enough of it to drive the full lifecycle.
  const ctx: any = {
    options,
    location: { directory: dir },
    provider: {
      async list() {
        return { data: providers }
      },
      async transform(cb: (editor: {
        update(id: string, fn: (p: { settings: Record<string, unknown> }) => void): void
      }) => void) {
        if (failNextTransform) throw new Error("simulated transform failure")
        await cb({
          update(id, fn) {
            const p = providers.find((q) => q.id === id)
            if (!p) throw new Error(`unknown provider ${id}`)
            fn({ settings: p.settings ?? {} })
          },
        })
      },
    },
    event: {
      subscribe() {
        return (async function* () {
          while (true) await new Promise(() => {})
        })()
      },
    },
    rpc: {
      register(_def: unknown, handlers: unknown) {
        ctx._handlers = handlers
        return {
          events: {
            emit: async (name: string, payload: unknown) => {
              emitted.push([name, payload])
            },
          },
        }
      },
    },
  }

  const dispose = (await plugin.setup(ctx)) as (() => Promise<void>) | undefined

  return {
    dispose,
    handlers: ctx._handlers as Handlers,
    emitted,
    setFailNextTransform(v: boolean) {
      failNextTransform = v
    },
    gateways: state.gateways,
  }
}

describe("plugin lifecycle wiring", () => {
  it("updateSettings rebuilds the gateway so new provider mappings take effect", async () => {
    const { dispose, handlers, emitted, gateways } = await boot(
      {
        proxies: { p1: { url: "http://proxy1:8080" } },
        providers: { a: "p1" },
      },
      [{ id: "a", settings: { baseURL: "https://api.example.com" } }],
    )
    try {
      expect(gateways.length).toBe(1)
      expect(gateways[0].closed).toBe(false)
      expect(await handlers.getSettings()).toMatchObject({
        active: true,
        providers: [{ id: "a", proxy: "p1" }],
      })

      await handlers.updateSettings({ providers: { a: null } })

      // A new gateway is built and the superseded one closes exactly once.
      expect(gateways.length).toBe(2)
      expect(gateways[0].closed).toBe(true)
      expect(gateways[1].closed).toBe(false)

      // The running gateway now reflects the cleared mapping (finding 1).
      const after = await handlers.getSettings()
      expect(after.active).toBe(false)
      expect(after.providers).toEqual([{ id: "a", proxy: null }])

      expect(emitted).toEqual([["updated", { providers: { a: null } }]])
    } finally {
      await dispose?.()
    }
  })

  it("keeps exactly one live gateway and closes each superseded gateway once across rebuilds", async () => {
    const { dispose, handlers, gateways } = await boot(
      {
        proxies: { p1: { url: "http://proxy1:8080" } },
        providers: { a: "p1" },
      },
      [{ id: "a", settings: { baseURL: "https://api.example.com" } }],
    )
    try {
      // Run several rebuilds through the serialized queue.
      await handlers.updateSettings({ providers: { a: "p1" } })
      await handlers.updateSettings({ providers: { a: "p1" } })

      expect(gateways.length).toBe(3) // initial + two rebuilds
      const live = gateways.filter((g) => !g.closed)
      // Exactly one live gateway, and it is the most recently built one.
      expect(live).toEqual([gateways[gateways.length - 1]])
      // Every superseded gateway closed exactly once.
      for (let i = 0; i < gateways.length - 1; i++) {
        expect(gateways[i].closed).toBe(true)
      }
    } finally {
      await dispose?.()
    }
  })

  it("keeps the previous gateway alive and propagates when a rebuild fails", async () => {
    const { dispose, handlers, gateways, setFailNextTransform } = await boot(
      {
        proxies: { p1: { url: "http://proxy1:8080" } },
        providers: { a: "p1" },
      },
      [{ id: "a", settings: { baseURL: "https://api.example.com" } }],
    )
    try {
      setFailNextTransform(true)
      await expect(
        handlers.updateSettings({ providers: { a: "p1" } }),
      ).rejects.toThrow("simulated transform failure")

      // The previous gateway is untouched and still serves the old state.
      expect(await handlers.getSettings()).toMatchObject({
        active: true,
        providers: [{ id: "a", proxy: "p1" }],
      })
      const live = gateways.filter((g) => !g.closed)
      expect(live).toEqual([gateways[0]])
      // The half-configured gateway was closed exactly once.
      expect(gateways.length).toBe(2)
      expect(gateways[1].closed).toBe(true)
    } finally {
      await dispose?.()
    }
  })
})
