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
