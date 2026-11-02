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
