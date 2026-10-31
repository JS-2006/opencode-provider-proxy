export interface ProxyTarget {
  url: string
  username?: string
  password?: string
}

export interface NormalizedOptions {
  proxies: ReadonlyMap<string, ProxyTarget>
  providers: ReadonlyMap<string, string> // providerID -> имя прокси
}

const ALLOWED_SCHEMES = ["http://", "https://", "socks4://", "socks5://"]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function normalizeOptions(raw: unknown): NormalizedOptions {
  if (!isRecord(raw)) {
    throw new Error(`options must be an object, got ${typeof raw}`)
  }

  const errors: string[] = []

  const proxies = new Map<string, ProxyTarget>()
  if (raw.proxies !== undefined) {
    if (!isRecord(raw.proxies)) {
      errors.push("proxies must be an object")
    } else {
      for (const [name, cfg] of Object.entries(raw.proxies)) {
        if (!isRecord(cfg)) {
          errors.push(`proxy "${name}" must be an object`)
          continue
        }
        const url = cfg.url
        if (typeof url !== "string" || url.length === 0) {
          errors.push(`proxy "${name}" is missing a url`)
          continue
        }
        if (!ALLOWED_SCHEMES.some((scheme) => url.startsWith(scheme))) {
          errors.push(`proxy "${name}" has an unsupported url scheme`)
          continue
        }
        const target: ProxyTarget = { url }
        if (typeof cfg.username === "string") target.username = cfg.username
        if (typeof cfg.password === "string") target.password = cfg.password
        proxies.set(name, target)
      }
    }
  }

  const providers = new Map<string, string>()
  if (raw.providers !== undefined) {
    if (!isRecord(raw.providers)) {
      errors.push("providers must be an object")
    } else {
      for (const [providerId, proxyName] of Object.entries(raw.providers)) {
        if (typeof proxyName !== "string") {
          errors.push(`provider "${providerId}" has a non-string proxy reference`)
          continue
        }
        if (!proxies.has(proxyName)) {
          errors.push(`provider "${providerId}" references unknown proxy "${proxyName}"`)
          continue
        }
        providers.set(providerId, proxyName)
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join("\n"))
  }

  return { proxies, providers }
}
