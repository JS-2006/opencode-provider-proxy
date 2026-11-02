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
      for (const [providerId, providerCfg] of Object.entries(raw.providers)) {
        let proxyName: string
        if (typeof providerCfg === "string") {
          proxyName = providerCfg
        } else if (isRecord(providerCfg)) {
          const cfgProxy = providerCfg.proxy
          if (typeof cfgProxy !== "string" || cfgProxy.length === 0) {
            errors.push(
              `provider "${providerId}" has an invalid proxy object (proxy must be a non-empty string)`,
            )
            continue
          }
          proxyName = cfgProxy
        } else {
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
