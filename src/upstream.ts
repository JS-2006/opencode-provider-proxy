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

/**
 * Maps an incoming request path to the upstream provider URL.
 *
 * Strips the `/${providerID}` route prefix from `reqPath` and resolves the
 * remainder against `baseURL`. A `TypeError` is thrown when `reqPath` does not
 * begin with the provider prefix.
 */
export function buildUpstreamUrl(
  baseURL: string,
  providerID: string,
  reqPath: string,
): URL {
  const prefix = `/${providerID}`
  if (!reqPath.startsWith(prefix)) {
    throw new TypeError(`request path must start with "${prefix}"`)
  }
  return new URL(reqPath.slice(prefix.length), baseURL)
}
