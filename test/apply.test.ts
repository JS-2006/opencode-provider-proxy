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

import { afterEach, describe, expect, it, vi } from "vitest"
import type { NormalizedOptions } from "../src/config.js"
import {
  applyRoutes,
  buildRoutes,
  resolveEnvPlaceholders,
  type RouteSpec,
} from "../src/apply.js"

describe("resolveEnvPlaceholders", () => {
  const original = process.env.API_HOST

  afterEach(() => {
    if (original === undefined) delete process.env.API_HOST
    else process.env.API_HOST = original
    vi.restoreAllMocks()
  })

  it("substitutes environment variable values", () => {
    process.env.API_HOST = "example.com"
    expect(resolveEnvPlaceholders("https://${API_HOST}/v1")).toBe(
      "https://example.com/v1",
    )
  })

  it("warns and substitutes an empty string when a variable is missing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    delete process.env.API_HOST
    expect(resolveEnvPlaceholders("https://${API_HOST}/v1")).toBe(
      "https:///v1",
    )
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe("buildRoutes", () => {
  const original = process.env.API_HOST

  afterEach(() => {
    if (original === undefined) delete process.env.API_HOST
    else process.env.API_HOST = original
    vi.restoreAllMocks()
  })

  it("resolves placeholders and skips providers without baseURL with a warning", () => {
    process.env.API_HOST = "example.com"
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const normalized: NormalizedOptions = {
      proxies: new Map([["p1", { url: "http://localhost:8080" }]]),
      providers: new Map([
        ["a", "p1"],
        ["b", "p1"],
      ]),
    }
    const providers = [
      { id: "a", settings: { baseURL: "https://${API_HOST}/v1" } },
      { id: "b", settings: {} },
    ]

    const routes = buildRoutes(normalized, providers)

    expect(routes.size).toBe(1)
    expect(routes.get("a")).toEqual({
      upstreamBase: "https://example.com/v1",
      proxyName: "p1",
    })
    expect(warn).toHaveBeenCalled()
  })
})

describe("applyRoutes", () => {
  it("sets the gateway baseURL and http transport via the provider transform", async () => {
    const states = new Map<string, { settings: Record<string, unknown> }>()
    const editor = {
      get: (pid: string) => ({ provider: states.get(pid) }),
      update: (pid: string, fn: (p: { settings: Record<string, unknown> }) => void) => {
        const provider = states.get(pid)!
        const copy = structuredClone(provider)
        fn(copy)
        states.set(pid, copy)
      },
    }
    const registered = { dispose: async () => {} }
    const transform = vi.fn(
      (cb: (e: typeof editor) => void) => {
        cb(editor)
        return Promise.resolve(registered)
      },
    )
    const ctx = { provider: { transform } }

    states.set("a", {
      settings: { apiKey: "secret", baseURL: "https://orig.example.com/api" },
    })
    const routes = new Map<string, RouteSpec>([
      ["a", { upstreamBase: "https://orig.example.com/api", proxyName: "p1" }],
    ])

    await applyRoutes(ctx as never, 7777, routes)

    expect(transform).toHaveBeenCalledTimes(1)
    const updated = states.get("a")!.settings
    expect(updated.baseURL).toBe("http://127.0.0.1:7777/a/api")
    expect(updated.transport).toBe("http")
    expect(updated.apiKey).toBe("secret")

    // The route definitions (upstream base, proxy name) must be preserved.
    expect(routes.get("a")).toEqual({
      upstreamBase: "https://orig.example.com/api",
      proxyName: "p1",
    })
  })
})
