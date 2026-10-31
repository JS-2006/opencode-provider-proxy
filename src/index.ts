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

    async function startGateway(): Promise<Running> {
      const normalized = normalizeOptions(ctx.options)
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

      await applyRoutes(ctx, gateway.port, routes)
      const running: Running = { gateway, normalized }
      current = running
      return running
    }

    await startGateway()

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

        const newOptions = optionsFromUpdate(running.normalized, { providers })
        const configFile = await findPluginConfigFile(ctx.location.directory)
        if (!configFile) throw new Error("no plugin config file found")
        await updatePluginOptions(configFile, newOptions)

        // Re-apply routes for the new options against the running gateway so the
        // change takes effect immediately (the config.updated subscription also
        // rebuilds the gateway; either path converges on the new settings).
        const nextNormalized = normalizeOptions(newOptions)
        const nextProviders = providerList(await ctx.provider.list())
        const nextRoutes = buildRoutes(nextNormalized, nextProviders)
        await applyRoutes(ctx, running.gateway.port, nextRoutes)
        current = { gateway: running.gateway, normalized: nextNormalized }

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
            // Build the new gateway first; only on success swap it in and
            // close the old one. If the rebuild fails, keep the old gateway
            // running so the proxy is not left dead.
            const previous = current as Running
            current = await startGateway()
            await previous.gateway.close()
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
