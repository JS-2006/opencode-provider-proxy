import { describe, expect, it } from "vitest"
import { normalizeOptions } from "../src/config.js"
import { getSettingsPayload, optionsFromUpdate } from "../src/rpc.js"

describe("getSettingsPayload", () => {
  it("reports active when at least one provider has a proxy", () => {
    const normalized = normalizeOptions({
      proxies: { p1: { url: "http://proxy1:8080" } },
      providers: { a: "p1" },
    })
    const payload = getSettingsPayload(normalized, [{ id: "a" }])
    expect(payload.active).toBe(true)
  })

  it("reports inactive when no provider has a proxy", () => {
    const normalized = normalizeOptions({
      proxies: { p1: { url: "http://proxy1:8080" } },
      providers: {},
    })
    const payload = getSettingsPayload(normalized, [{ id: "a" }])
    expect(payload.active).toBe(false)
  })

  it("lists proxies with name, url and auth flag derived from credentials", () => {
    const normalized = normalizeOptions({
      proxies: {
        p1: { url: "http://proxy1:8080" },
        p2: { url: "http://proxy2:8080", username: "u", password: "pw" },
      },
      providers: {},
    })
    const payload = getSettingsPayload(normalized, [])
    expect(payload.proxies).toEqual([
      { name: "p1", url: "http://proxy1:8080", auth: false },
      { name: "p2", url: "http://proxy2:8080", auth: true },
    ])
  })

  it("lists every known provider with its proxy name or null", () => {
    const normalized = normalizeOptions({
      proxies: { p1: { url: "http://proxy1:8080" } },
      providers: { a: "p1" },
    })
    const payload = getSettingsPayload(normalized, [{ id: "a" }, { id: "b" }])
    expect(payload.providers).toEqual([
      { id: "a", proxy: "p1" },
      { id: "b", proxy: null },
    ])
  })

  it("never exposes credentials in the payload", () => {
    const normalized = normalizeOptions({
      proxies: {
        p1: { url: "http://proxy1:8080", username: "secretuSer", password: "hunter2" },
      },
      providers: {},
    })
    const payload = getSettingsPayload(normalized, [])
    expect(JSON.stringify(payload)).not.toContain("secretuSer")
    expect(JSON.stringify(payload)).not.toContain("hunter2")
  })
})

describe("optionsFromUpdate", () => {
  it("sets a provider proxy while keeping existing proxy definitions untouched", () => {
    const current = normalizeOptions({
      proxies: {
        p1: { url: "http://proxy1:8080" },
        p2: { url: "http://proxy2:8080" },
      },
      providers: {},
    })
    const next = optionsFromUpdate(current, { providers: { a: "p1" } })
    expect(next.proxies).toEqual({
      p1: { url: "http://proxy1:8080" },
      p2: { url: "http://proxy2:8080" },
    })
    expect(next.providers).toEqual({ a: { proxy: "p1" } })
  })

  it("clears a provider mapping when the proxy value is null", () => {
    const current = normalizeOptions({
      proxies: { p1: { url: "http://proxy1:8080" } },
      providers: { a: "p1", b: "p1" },
    })
    const next = optionsFromUpdate(current, { providers: { a: null } })
    expect(next.providers).toEqual({})
    expect(next.proxies).toEqual({ p1: { url: "http://proxy1:8080" } })
  })

  it("replaces the provider table rather than merging", () => {
    const current = normalizeOptions({
      proxies: { p1: { url: "http://proxy1:8080" } },
      providers: { a: "p1" },
    })
    const next = optionsFromUpdate(current, { providers: { b: "p1" } })
    expect(next.providers).toEqual({ b: { proxy: "p1" } })
  })

  it("rejects an unknown proxy name before building options", () => {
    const current = normalizeOptions({
      proxies: { p1: { url: "http://proxy1:8080" } },
      providers: {},
    })
    expect(() =>
      optionsFromUpdate(current, { providers: { a: "nonexistent" } }),
    ).toThrow(/proxy "nonexistent" is not configured/)
  })

  it("allows clearing a mapping to null even alongside an unknown name for others", () => {
    const current = normalizeOptions({
      proxies: { p1: { url: "http://proxy1:8080" } },
      providers: { a: "p1" },
    })
    const next = optionsFromUpdate(current, { providers: { a: null, b: "p1" } })
    expect(next.providers).toEqual({ b: { proxy: "p1" } })
  })
})
