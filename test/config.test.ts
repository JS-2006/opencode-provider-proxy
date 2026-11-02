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

import { describe, expect, it } from "vitest"
import { normalizeOptions } from "../src/config.js"

describe("normalizeOptions", () => {
  it("returns empty maps for an empty object", () => {
    const r = normalizeOptions({})
    expect(r.proxies.size).toBe(0)
    expect(r.providers.size).toBe(0)
  })

  it("normalizes valid options", () => {
    const r = normalizeOptions({
      proxies: {
        p1: { url: "http://localhost:8080", username: "u", password: "p" },
        p2: { url: "socks5://proxy.example.com:1080" },
      },
      providers: {
        openai: "p1",
        anthropic: "p2",
      },
    })
    expect(r.proxies.get("p1")).toEqual({
      url: "http://localhost:8080",
      username: "u",
      password: "p",
    })
    expect(r.proxies.get("p2")).toEqual({
      url: "socks5://proxy.example.com:1080",
    })
    expect(r.providers.get("openai")).toBe("p1")
    expect(r.providers.get("anthropic")).toBe("p2")
  })

  it("throws when providers reference an unknown proxy", () => {
    expect(() => normalizeOptions({ providers: { openai: "nope" } })).toThrow(
      /nope/,
    )
  })

  it("accepts the object form for providers", () => {
    const r = normalizeOptions({
      proxies: {
        p1: { url: "http://localhost:8080" },
        p2: { url: "socks5://proxy.example.com:1080" },
      },
      providers: {
        openai: { proxy: "p1" },
        anthropic: { proxy: "p2" },
      },
    })
    expect(r.providers.get("openai")).toBe("p1")
    expect(r.providers.get("anthropic")).toBe("p2")
  })

  it("accepts a mix of string and object forms for providers", () => {
    const r = normalizeOptions({
      proxies: {
        p1: { url: "http://localhost:8080" },
      },
      providers: {
        openai: "p1",
        anthropic: { proxy: "p1" },
      },
    })
    expect(r.providers.get("openai")).toBe("p1")
    expect(r.providers.get("anthropic")).toBe("p1")
  })

  it("throws when an object provider is missing proxy", () => {
    expect(() => normalizeOptions({ providers: { openai: {} } })).toThrow(
      /proxy must be a non-empty string/,
    )
  })

  it("throws when an object provider has a non-string proxy", () => {
    expect(() =>
      normalizeOptions({ providers: { openai: { proxy: 42 } } }),
    ).toThrow(/proxy must be a non-empty string/)
  })

  it("throws when an object provider references an unknown proxy", () => {
    expect(() =>
      normalizeOptions({ providers: { openai: { proxy: "nope" } } }),
    ).toThrow(/nope/)
  })

  it("throws on an unsupported url scheme", () => {
    expect(() =>
      normalizeOptions({ proxies: { p1: { url: "ftp://example.com" } } }),
    ).toThrow(/scheme/)
    expect(() =>
      normalizeOptions({ proxies: { p1: { url: "gopher://example.com" } } }),
    ).toThrow(/scheme/)
  })

  it("throws when url is missing", () => {
    expect(() => normalizeOptions({ proxies: { p1: {} } })).toThrow(/url/)
  })

  it("throws when raw is not an object", () => {
    expect(() => normalizeOptions("nope")).toThrow(/object|string/)
    expect(() => normalizeOptions(null)).toThrow(/object/)
    expect(() => normalizeOptions([1, 2])).toThrow(/object|array/)
  })

  it("collects all errors into the message", () => {
    let err: Error | undefined
    try {
      normalizeOptions({
        proxies: { p1: {} },
        providers: { openai: "missing" },
      })
    } catch (e) {
      err = e as Error
    }
    expect(err).toBeDefined()
    expect(err!.message).toContain("p1")
    expect(err!.message).toContain("missing")
  })
})
