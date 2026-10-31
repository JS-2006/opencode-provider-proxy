import { describe, expect, it } from "vitest"
import plugin from "../src/index.js"

describe("plugin", () => {
  it("has id provider-proxy", () => {
    expect(plugin.id).toBe("provider-proxy")
  })
})
