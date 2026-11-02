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

const tick = () => new Promise<void>((r) => setTimeout(r, 20))

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

// A pushable async iterator so tests can drive the `config.updated` subscription.
function makeSubscription() {
  const pending: unknown[] = []
  const waiters: Array<() => void> = []
  return {
    push(ev: unknown) {
      pending.push(ev)
      waiters.shift()?.()
    },
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          for (;;) {
            if (pending.length > 0) {
              return { value: pending.shift(), done: false }
            }
            await new Promise<void>((r) => waiters.push(r))
          }
        },
        return: async () => ({ value: undefined, done: true }),
      }
    },
  }
}

async function boot(options: unknown, providers: ProviderShape[]) {
  state.gateways.length = 0
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "proxy-lifecycle-"))
  const configPath = path.join(dir, "opencode.json")
  await fs.writeFile(
    configPath,
    JSON.stringify({
      plugins: [{ package: "opencode-provider-proxy", options }],
    }),
    "utf8",
  )

  let failNextTransform = false
  const emitted: Array<[string, unknown]> = []
  const sub = makeSubscription()

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
        return sub
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

  // Initialization is intentionally off the setup critical path (setTimeout 0);
  // wait for it so the tests observe the ready state, as they did before.
  await tick()

  return {
    dispose,
    configPath,
    handlers: ctx._handlers as Handlers,
    emitted,
    subPush: (ev: unknown) => sub.push(ev),
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
      // Run several distinct rebuilds through the serialized queue.
      await handlers.updateSettings({ providers: { a: null } })
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
        handlers.updateSettings({ providers: { a: null } }),
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

  it("an RPC update followed by config.updated neither reverts nor spawns a duplicate gateway", async () => {
    const { dispose, handlers, subPush, gateways } = await boot(
      {
        proxies: { p1: { url: "http://proxy1:8080" } },
        providers: { a: "p1" },
      },
      [{ id: "a", settings: { baseURL: "https://api.example.com" } }],
    )
    try {
      expect(gateways.length).toBe(1)

      // RPC clears the mapping: writes the config file and rebuilds.
      await handlers.updateSettings({ providers: { a: null } })
      expect(gateways.length).toBe(2)
      expect(gateways[1].closed).toBe(false)

      // A watcher config.updated fires afterwards. It must read the freshly
      // written file state (providers: {}), see it matches the applied gateway,
      // and become a no-op rather than reverting to the stale ctx.options.
      subPush({ type: "config.updated" })
      await tick()

      expect(gateways.length).toBe(2) // no double gateway
      expect(gateways[1].closed).toBe(false) // still live — not reverted
      expect(await handlers.getSettings()).toMatchObject({
        active: false,
        providers: [{ id: "a", proxy: null }],
      })
    } finally {
      await dispose?.()
    }
  })

  it("dispose aborts, stops the subscription, and refuses further rebuilds", async () => {
    const { dispose, handlers, gateways } = await boot(
      {
        proxies: { p1: { url: "http://proxy1:8080" } },
        providers: { a: "p1" },
      },
      [{ id: "a", settings: { baseURL: "https://api.example.com" } }],
    )
    expect(gateways[0].closed).toBe(false)

    await dispose!()

    expect(gateways[0].closed).toBe(true)
    // A rebuild after dispose is refused (abort flag) instead of creating a gateway.
    await expect(
      handlers.updateSettings({ providers: { a: null } }),
    ).rejects.toThrow(/shutdown in progress/)
    expect(gateways.length).toBe(1)
  })

  it("teardown awaits an in-flight config rebuild and closes every gateway", async () => {
    const { dispose, subPush, gateways, configPath } = await boot(
      {
        proxies: { p1: { url: "http://proxy1:8080" } },
        providers: { a: "p1" },
      },
      [{ id: "a", settings: { baseURL: "https://api.example.com" } }],
    )
    // Change the config to a distinct state so config.updated triggers a real rebuild.
    await fs.writeFile(
      configPath,
      JSON.stringify({
        plugins: [
          {
            package: "opencode-provider-proxy",
            options: {
              proxies: { p1: { url: "http://proxy1:8080" } },
              providers: {},
            },
          },
        ],
      }),
      "utf8",
    )
    subPush({ type: "config.updated" })
    await new Promise((r) => setTimeout(r, 15)) // let the subscription loop enqueue
    await dispose!()

    // Whatever gateways were created (including the in-flight rebuild) are closed.
    for (const g of gateways) {
      expect(g.closed).toBe(true)
    }
  })
})
