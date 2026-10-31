import { describe, expect, it } from "vitest"
import { buildUpstreamUrl } from "../src/upstream.js"

describe("buildUpstreamUrl", () => {
  it("maps a provider-prefixed path onto the base URL", () => {
    const url = buildUpstreamUrl(
      "https://api.anthropic.com/v1",
      "anthropic",
      "/anthropic/v1/messages?limit=1",
    )
    expect(url.toString()).toBe("https://api.anthropic.com/v1/messages?limit=1")
  })

  it("handles a base URL with a trailing slash", () => {
    const url = buildUpstreamUrl(
      "https://api.anthropic.com/v1/",
      "anthropic",
      "/anthropic/v1/messages?limit=1",
    )
    expect(url.toString()).toBe("https://api.anthropic.com/v1/messages?limit=1")
  })

  it("throws TypeError when the path lacks the provider prefix", () => {
    expect(() =>
      buildUpstreamUrl(
        "https://api.anthropic.com/v1",
        "anthropic",
        "/v1/messages",
      ),
    ).toThrow(TypeError)
  })

  it("preserves the query string", () => {
    const url = buildUpstreamUrl(
      "https://api.openai.com/v1",
      "openai",
      "/openai/v1/chat/completions?model=gpt-4o&n=2",
    )
    expect(url.search).toBe("?model=gpt-4o&n=2")
    expect(url.pathname).toBe("/v1/chat/completions")
  })
})
