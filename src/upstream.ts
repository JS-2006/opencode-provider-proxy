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
