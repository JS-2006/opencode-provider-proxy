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

import { Plugin } from "@opencode/plugin"
import { normalizeOptions, type NormalizedOptions } from "./config.js"
import { createGateway } from "./gateway.js"
import { applyRoutes, buildRoutes } from "./apply.js"
import { buildUpstreamUrl } from "./upstream.js"
import { findPluginConfigFile, readPluginOptions, updatePluginOptions } from "./jsonc-config.js"
import { ProviderProxy, getSettingsPayload, optionsFromUpdate } from "./rpc.js"

interface ProviderRef {
  id: string
  settings?: { baseURL?: string }
}

function providerList(list: { data: Array<{ id: string; settings?: unknown }> }): ProviderRef[] {
  return list.data.map((p) => ({
    id: p.id,
    settings: p.settings
      ? { baseURL: (p.settings as { baseURL?: string }).baseURL }
      : undefined,
  }))
}

export default Plugin.define({
  id: "provider-proxy",
  async setup(ctx) {
    const abort = new AbortController()

    interface Running {
      gateway: { port: number; close: () => Promise<void> }
      normalized: NormalizedOptions
      routes: ReturnType<typeof buildRoutes>
    }

    let current: Running | undefined
    let registration: Awaited<
      ReturnType<typeof ctx.rpc.register<typeof ProviderProxy>>
    > | undefined

    function sameNormalized(a: NormalizedOptions, b: NormalizedOptions): boolean {
      const mapsEqual = (
        x: ReadonlyMap<string, unknown>,
        y: ReadonlyMap<string, unknown>,
      ): boolean => {
        if (x.size !== y.size) return false
        for (const [key, value] of x) {
          if (!y.has(key)) return false
          if (JSON.stringify(value) !== JSON.stringify(y.get(key))) return false
        }
        return true
      }
      return mapsEqual(a.proxies, b.proxies) && mapsEqual(a.providers, b.providers)
    }

    function sameRoutes(
      a: ReturnType<typeof buildRoutes>,
      b: ReturnType<typeof buildRoutes>,
    ): boolean {
      if (a.size !== b.size) return false
      for (const [providerId, spec] of a) {
        if (!b.has(providerId)) return false
        if (JSON.stringify(spec) !== JSON.stringify(b.get(providerId))) return false
      }
      return true
    }

    /**
     * Build a fresh gateway from `options`, re-apply routes, then atomically
     * swap it in as `current` and close the superseded gateway (exactly once).
     * On any failure the previously-live gateway is left untouched and the
     * error propagates to the caller.
     *
     * The rebuild is idempotent: if the normalized options and the computed
     * routes already match the currently-applied gateway, it returns that
     * gateway without creating a new one. This keeps a redundant
     * `config.updated` rebuild (e.g. one that fires after an RPC update already
     * applied the same state) from reverting the change or spinning up a
     * duplicate gateway, while still reacting to provider-list/baseURL changes.
     */
    async function doRebuild(options: unknown): Promise<Running> {
      if (abort.signal.aborted) {
        throw new Error("provider-proxy: shutdown in progress")
      }
      const normalized = normalizeOptions(options)
      const providers = providerList(await ctx.provider.list())
      const routes = buildRoutes(normalized, providers)
      if (
        current &&
        sameNormalized(normalized, current.normalized) &&
        sameRoutes(routes, current.routes)
      ) {
        return current
      }

      const gateway = await createGateway({
        resolveUpstream: (providerID, reqPath) => {
          const spec = routes.get(providerID)
          if (!spec) return undefined
          return { url: buildUpstreamUrl(spec.upstreamBase, providerID, reqPath) }
        },
        getProxy: (providerID) => {
          const proxyName = normalized.providers.get(providerID)
          if (!proxyName) return undefined
          return normalized.proxies.get(proxyName)
        },
      })

      try {
        if (abort.signal.aborted) {
          throw new Error("provider-proxy: shutdown in progress")
        }
        await applyRoutes(ctx, gateway.port, routes)
      } catch (err) {
        // Never leak a half-configured gateway; the previous one stays live.
        await gateway.close()
        throw err
      }

      const next: Running = { gateway, normalized, routes }
      const previous = current
      current = next
      if (previous) await previous.gateway.close()
      return next
    }

    // Serialize every rebuild through a promise chain so event-driven and RPC
    // rebuilds queue instead of interleaving. A failed rebuild does not poison
    // the chain; subsequent rebuilds still run.
    let rebuildQueue: Promise<unknown> = Promise.resolve()
    function rebuild(options: unknown = ctx.options): Promise<Running> {
      const run = rebuildQueue.then(() => doRebuild(options))
      rebuildQueue = run.catch(() => {
        /* swallow to keep the queue alive; the error is delivered to the caller */
      })
      return run
    }

    // Startup: build the initial gateway/routes OUTSIDE the setup critical path.
    // Awaiting `ctx.provider.list()` during plugin setup can deadlock the
    // provider registry (observed as a reload loop), so we schedule the first
    // rebuild for the next tick and return from setup immediately.
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let attempts = 0
    const startInit = () => {
      if (abort.signal.aborted) return
      rebuild()
        .then((r) => {
          clearInterval(retryTimer)
          console.log(
            `provider-proxy: active, gateway on 127.0.0.1:${r.gateway.port}, routes=${r.routes.size}`,
          )
        })
        .catch((err) => {
          console.error("provider-proxy: initial rebuild failed, will retry", err)
          if (!retryTimer && !abort.signal.aborted) {
            retryTimer = setInterval(() => {
              if (abort.signal.aborted || attempts >= 10) {
                clearInterval(retryTimer)
                return
              }
              attempts += 1
              rebuild()
                .then((r) => {
                  clearInterval(retryTimer)
                  console.log(
                    `provider-proxy: rebuilt ok, gateway on 127.0.0.1:${r.gateway.port}, routes=${r.routes.size}`,
                  )
                })
                .catch((e) => console.error("provider-proxy: retry rebuild failed", e))
            }, 2000)
          }
        })
    }
    setTimeout(startInit, 0)

    registration = await ctx.rpc.register(ProviderProxy, {
      async getSettings() {
        const running = current as Running | undefined
        if (!running) {
          // Startup init hasn't completed yet (it runs off the setup critical
          // path); report an empty but valid state.
          return { active: false, proxies: [], providers: [] }
        }
        return getSettingsPayload(
          running.normalized,
          providerList(await ctx.provider.list()),
        )
      },
      async updateSettings(input) {
        const { providers } = input as { providers: Record<string, string | null> }
        const running = current as Running | undefined
        if (!running) throw new Error("provider-proxy: not ready yet")

        // `optionsFromUpdate` encodes providers as `{ proxy: name }` objects
        // (the jsonc persistence shape), but `normalizeOptions` consumes a plain
        // `provider -> name` string map. Bridge the two shapes here so the
        // same object can be persisted and rebuilt.
        const newOptions = optionsFromUpdate(running.normalized, { providers })
        const providersTable: Record<string, string> = {}
        for (const [providerId, target] of Object.entries(newOptions.providers)) {
          providersTable[providerId] = target.proxy
        }
        const nextOptions = { proxies: newOptions.proxies, providers: providersTable }

        const configFile = await findPluginConfigFile(ctx.location.directory)
        if (!configFile) throw new Error("no plugin config file found")
        await updatePluginOptions(configFile, nextOptions)

        // Rebuild through the same serialized path as config.updated. This
        // rebuilds the gateway from fresh state and rewrites provider routes;
        // on failure the previous gateway stays alive and the error propagates.
        await rebuild(nextOptions)

        await registration?.events.emit("updated", { providers })
        return { ok: true }
      },
    })

    const subscription = ctx.event.subscribe({ types: ["config.updated"] })
    const subIter = subscription[Symbol.asyncIterator]() as AsyncIterableIterator<unknown>

    void (async () => {
      try {
        for await (const _event of subIter) {
          if (abort.signal.aborted) break
          try {
            // Rebuild from the freshly-read config file rather than the
            // in-memory `ctx.options` snapshot, which may be stale relative to
            // a just-applied RPC update. Combined with the idempotent rebuild
            // in `doRebuild`, a redundant watcher event after an RPC update is
            // a no-op instead of a revert.
            const fresh = await readPluginOptions(ctx.location.directory)
            await rebuild(fresh ?? ctx.options)
          } catch (err) {
            console.error("provider-proxy: rebuild failed, keeping existing gateway active", err)
          }
        }
      } catch (err) {
        console.error("provider-proxy: config subscription ended unexpectedly", err)
      }
    })()

    return async () => {
      // Signal shutdown first: rebuilds started after this point become no-ops.
      abort.abort()
      if (retryTimer) clearInterval(retryTimer)
      // Stop the config-subscription consumer loop.
      if (typeof (subIter as { return?: unknown }).return === "function") {
        try {
          await (subIter as { return: () => Promise<unknown> }).return()
        } catch {
          /* best effort */
        }
      }
      // Await any queued/in-flight rebuild so it settles before we resolve; the
      // abort flag makes skipped/pending work exit without creating a gateway.
      await rebuildQueue.catch(() => {})
      if (current) await current.gateway.close()
    }
  },
})
