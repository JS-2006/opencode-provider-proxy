import { Rpc } from "@opencode/plugin/rpc"
import type { NormalizedOptions, ProxyTarget } from "./config.js"

export const ProviderProxy = Rpc.define({
  id: "provider-proxy",
  methods: {
    getSettings: {
      input: { type: "object", additionalProperties: false },
      output: {
        type: "object",
        properties: {
          active: { type: "boolean" },
          proxies: { type: "array", items: { type: "object", properties: {
            name: { type: "string" }, url: { type: "string" }, auth: { type: "boolean" }
          }, required: ["name", "url", "auth"], additionalProperties: false } },
          providers: { type: "array", items: { type: "object", properties: {
            id: { type: "string" }, proxy: { type: ["string", "null"] }
          }, required: ["id", "proxy"], additionalProperties: false } }
        },
        required: ["active", "proxies", "providers"],
        additionalProperties: false
      }
    },
    updateSettings: {
      input: {
        type: "object",
        properties: {
          providers: { type: "object", additionalProperties: { type: ["string", "null"] } }
        },
        required: ["providers"],
        additionalProperties: false
      },
      output: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false }
    }
  },
  events: {
    updated: { schema: { type: "object", properties: { providers: { type: "object" } }, required: ["providers"], additionalProperties: false } }
  }
})

export function getSettingsPayload(
  normalized: NormalizedOptions,
  providerList: ReadonlyArray<{ id: string }>,
): {
  active: boolean
  proxies: Array<{ name: string; url: string; auth: boolean }>
  providers: Array<{ id: string; proxy: string | null }>
} {
  const proxies: Array<{ name: string; url: string; auth: boolean }> = []
  for (const [name, target] of normalized.proxies) {
    proxies.push({
      name,
      url: target.url,
      auth: target.username !== undefined || target.password !== undefined,
    })
  }

  const providers: Array<{ id: string; proxy: string | null }> = []
  for (const provider of providerList) {
    providers.push({
      id: provider.id,
      proxy: normalized.providers.get(provider.id) ?? null,
    })
  }

  return {
    active: normalized.providers.size > 0,
    proxies,
    providers,
  }
}

/**
 * Compute the next `options` object from the current normalized options and an
 * update that sets or clears provider→proxy mappings. Existing proxy
 * definitions are preserved untouched; a `null` proxy value means the provider
 * mapping should be absent.
 */
export function optionsFromUpdate(
  current: NormalizedOptions,
  update: { providers: Record<string, string | null> },
): { proxies: Record<string, ProxyTarget>; providers: Record<string, { proxy: string }> } {
  const proxies: Record<string, ProxyTarget> = Object.fromEntries(current.proxies)

  const providers: Record<string, { proxy: string }> = {}
  for (const [providerId, proxyName] of Object.entries(update.providers)) {
    if (proxyName === null) continue
    // Reject any proxy name that is not configured before the caller persists
    // the mapping, so a bad RPC payload can never corrupt the on-disk config.
    if (!current.proxies.has(proxyName)) {
      throw new Error(`proxy "${proxyName}" is not configured`)
    }
    providers[providerId] = { proxy: proxyName }
  }

  return { proxies, providers }
}
