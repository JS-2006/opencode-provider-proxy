import { Plugin } from "@opencode/plugin"
import { normalizeOptions, type NormalizedOptions } from "./config.js"
import { createGateway } from "./gateway.js"
import { applyRoutes, buildRoutes } from "./apply.js"
import { buildUpstreamUrl } from "./upstream.js"
import { findPluginConfigFile, updatePluginOptions } from "./jsonc-config.js"
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
    }

    let current: Running | undefined
    let registration: Awaited<
      ReturnType<typeof ctx.rpc.register<typeof ProviderProxy>>
    > | undefined

    /**
     * Build a fresh gateway from `options`, re-apply routes, then atomically
     * swap it in as `current` and close the superseded gateway (exactly once).
     * On any failure the previously-live gateway is left untouched and the
     * error propagates to the caller.
     */
    async function doRebuild(options: unknown): Promise<Running> {
      const normalized = normalizeOptions(options)
      const providers = providerList(await ctx.provider.list())
      const routes = buildRoutes(normalized, providers)

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
        await applyRoutes(ctx, gateway.port, routes)
      } catch (err) {
        // Never leak a half-configured gateway; the previous one stays live.
        await gateway.close()
        throw err
      }

      const next: Running = { gateway, normalized }
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

    await rebuild()

    registration = await ctx.rpc.register(ProviderProxy, {
      async getSettings() {
        const running = current as Running
        return getSettingsPayload(
          running.normalized,
          providerList(await ctx.provider.list()),
        )
      },
      async updateSettings(input) {
        const { providers } = input as { providers: Record<string, string | null> }
        const running = current as Running

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
    void (async () => {
      try {
        for await (const _event of subscription) {
          if (abort.signal.aborted) break
          try {
            await rebuild()
          } catch (err) {
            console.error("provider-proxy: rebuild failed, keeping existing gateway active", err)
          }
        }
      } catch (err) {
        console.error("provider-proxy: config subscription ended unexpectedly", err)
      }
    })()

    return async () => {
      abort.abort()
      await (current as Running).gateway.close()
    }
  },
})
