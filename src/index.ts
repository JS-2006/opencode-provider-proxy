import { Plugin } from "@opencode/plugin"
import { normalizeOptions } from "./config.js"
import { createGateway } from "./gateway.js"
import { applyRoutes, buildRoutes } from "./apply.js"
import { buildUpstreamUrl } from "./upstream.js"

export default Plugin.define({
  id: "provider-proxy",
  async setup(ctx) {
    const abort = new AbortController()

    async function startGateway() {
      const normalized = normalizeOptions(ctx.options)
      const list = await ctx.provider.list()
      const providers = list.data.map((p) => ({
        id: p.id,
        settings: p.settings
          ? { baseURL: (p.settings as { baseURL?: string }).baseURL }
          : undefined,
      }))
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
      return { gateway, routes }
    }

    let current = await startGateway()

    const subscription = ctx.event.subscribe({ types: ["config.updated"] })
    void (async () => {
      try {
        for await (const _event of subscription) {
          if (abort.signal.aborted) break
          try {
            // Build the new gateway first; only on success swap it in and
            // close the old one. If the rebuild fails, keep the old gateway
            // running so the proxy is not left dead.
            const next = await startGateway()
            const previous = current
            current = next
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
      await current.gateway.close()
    }
  },
})
