import type { NormalizedOptions } from "./config.js"

export interface RouteSpec {
  upstreamBase: string
  proxyName?: string
}

/**
 * Replace `${NAME}` placeholders with `process.env[NAME]`. When a variable is
 * not set, warn and substitute the empty string.
 */
export function resolveEnvPlaceholders(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_match, name: string) => {
    const resolved = process.env[name]
    if (resolved === undefined) {
      console.warn(`environment variable "${name}" is not set; substituting an empty string`)
      return ""
    }
    return resolved
  })
}

/**
 * Build the route table for the providers configured in `normalized`. Providers
 * that appear in `normalized.providers` but lack a `settings.baseURL` are
 * skipped with a warning; the rest get their `upstreamBase` resolved from
 * environment placeholders.
 */
export function buildRoutes(
  normalized: NormalizedOptions,
  providers: ReadonlyArray<{ id: string; settings?: { baseURL?: string } }>,
): Map<string, RouteSpec> {
  const byId = new Map(providers.map((p) => [p.id, p]))
  const routes = new Map<string, RouteSpec>()

  for (const [providerId, proxyName] of normalized.providers) {
    const provider = byId.get(providerId)
    if (!provider) continue

    const baseURL = provider.settings?.baseURL
    if (typeof baseURL !== "string" || baseURL.length === 0) {
      console.warn(`provider "${providerId}" has no baseURL; skipping`)
      continue
    }

    routes.set(providerId, {
      upstreamBase: resolveEnvPlaceholders(baseURL),
      proxyName,
    })
  }

  return routes
}

interface ProviderEditor {
  get(providerID: string): { provider?: { settings?: { baseURL?: string } } } | undefined
  update(providerID: string, update: (provider: { settings: Record<string, unknown> }) => void): void
}

/**
 * Rewrite each routed provider's `settings.baseURL` to point at the local
 * gateway and force `transport: "http"`, via the provider transform.
 */
export async function applyRoutes(
  ctx: unknown,
  gatewayPort: number,
  routes: Map<string, RouteSpec>,
): Promise<void> {
  const transform = (ctx as { provider?: { transform?: (cb: (editor: ProviderEditor) => void) => Promise<unknown> } })
    ?.provider?.transform
  if (!transform) {
    throw new Error("ctx.provider.transform is unavailable")
  }

  await transform((editor) => {
    for (const providerId of routes.keys()) {
      editor.update(providerId, (provider) => {
        provider.settings = {
          ...provider.settings,
          baseURL: `http://127.0.0.1:${gatewayPort}/${providerId}`,
          transport: "http",
        }
      })
    }
  })
}
