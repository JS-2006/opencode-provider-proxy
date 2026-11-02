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
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parse, parseTree, type Node } from "jsonc-parser"
import {
  findPluginConfigFile,
  PLUGIN_NAMES,
  updatePluginOptions,
} from "../src/jsonc-config.js"

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "jsonc",
)

describe("PLUGIN_NAMES", () => {
  it("includes both canonical names", () => {
    expect(PLUGIN_NAMES).toContain("opencode-provider-proxy")
    expect(PLUGIN_NAMES).toContain("provider-proxy")
  })
})

describe("updatePluginOptions", () => {
  it("edits only the target plugin options, preserving comments/trailing commas byte-for-byte", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jsonc-test-"))
    const file = path.join(dir, "opencode.jsonc")
    await fs.copyFile(path.join(fixturesDir, "with-options.opencode.jsonc"), file)
    const orig = await fs.readFile(file, "utf8")
    const newOptions = { proxies: { p1: { url: "http://localhost:8080" } } }

    await updatePluginOptions(file, newOptions)

    const updated = await fs.readFile(file, "utf8")
    // The full file must equal the original with exactly the target `options`
    // value node replaced by the re-serialized new value — proving every other
    // byte (comments, trailing commas, formatting) is preserved.
    const node = optsNode(orig)
    const expected =
      orig.slice(0, node.offset) +
      JSON.stringify(newOptions) +
      orig.slice(node.offset + node.length)
    expect(updated).toBe(expected)
    expect(updated).toContain('"p1"')
  })

  it("adds an options object when the plugin entry has none", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jsonc-test-"))
    const file = path.join(dir, "opencode.jsonc")
    await fs.copyFile(path.join(fixturesDir, "no-options.opencode.jsonc"), file)
    const orig = await fs.readFile(file, "utf8")

    await updatePluginOptions(file, { foo: 1 })

    const updated = await fs.readFile(file, "utf8")
    const { changedNew, suffix } = longestCommonPrefixSuffix(orig, updated)
    expect(changedNew).toContain('"options"')
    expect(changedNew).toContain('"foo":1')
    // the tail after the inserted options is untouched
    expect(suffix.length).toBeGreaterThan(0)
  })

  it("edits the matching entry when package is given as a basename path", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jsonc-test-"))
    const file = path.join(dir, "opencode.jsonc")
    await fs.copyFile(path.join(fixturesDir, "package-basename.opencode.jsonc"), file)

    await updatePluginOptions(file, { b: 2 })

    const updated = await fs.readFile(file, "utf8")
    expect(updated).toContain('"b":2')
    expect(updated).toContain('"./plugins/provider-proxy"')
  })

  it("converts a plain string-form plugin entry to object form on update", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jsonc-test-"))
    const file = path.join(dir, "opencode.jsonc")
    await fs.copyFile(path.join(fixturesDir, "string-form.opencode.jsonc"), file)
    const orig = await fs.readFile(file, "utf8")
    const newOptions = { c: 3 }

    await updatePluginOptions(file, newOptions)

    const updated = await fs.readFile(file, "utf8")
    // The scalar string entry must be replaced by an object preserving the
    // original package value; everything else stays byte-identical.
    const entry = entryNode(orig, 0)
    const pkg = entry.value as string
    const expected =
      orig.slice(0, entry.offset) +
      JSON.stringify({ package: pkg, options: newOptions }) +
      orig.slice(entry.offset + entry.length)
    expect(updated).toBe(expected)
    expect(parse(updated).plugins[0]).toEqual({
      package: "opencode-provider-proxy",
      options: { c: 3 },
    })
  })

  it("converts a string-form plugin entry with a relative package path on update", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "jsonc-test-"))
    const file = path.join(dir, "opencode.jsonc")
    await fs.copyFile(path.join(fixturesDir, "string-form-path.opencode.jsonc"), file)
    const orig = await fs.readFile(file, "utf8")

    await updatePluginOptions(file, { d: 4 })

    const updated = await fs.readFile(file, "utf8")
    const entry = entryNode(orig, 0)
    const expected =
      orig.slice(0, entry.offset) +
      JSON.stringify({ package: entry.value, options: { d: 4 } }) +
      orig.slice(entry.offset + entry.length)
    expect(updated).toBe(expected)
    expect(parse(updated).plugins[0]).toEqual({
      package: "./plugins/provider-proxy",
      options: { d: 4 },
    })
  })
})

describe("findPluginConfigFile", () => {
  it("returns the nearest ancestor config that contains the plugin", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "jsonc-search-"))
    await fs.mkdir(path.join(root, "nested"), { recursive: true })
    await fs.copyFile(
      path.join(fixturesDir, "search", "opencode.json"),
      path.join(root, "opencode.json"),
    )
    await fs.copyFile(
      path.join(fixturesDir, "search", "nested", "opencode.json"),
      path.join(root, "nested", "opencode.json"),
    )

    const found = await findPluginConfigFile(path.join(root, "nested"))

    expect(found).toBe(path.join(root, "nested", "opencode.json"))
  })

  it("falls back to the global config, creating it when absent", async () => {
    const work = await fs.mkdtemp(path.join(os.tmpdir(), "jsonc-global-"))
    const cfgHome = path.join(work, "xdg")
    const prev = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = cfgHome
    try {
      const found = await findPluginConfigFile(work)
      const expected = path.join(cfgHome, "opencode", "opencode.json")
      expect(found).toBe(expected)
      const content = await fs.readFile(expected, "utf8")
      expect(content).toContain("opencode-provider-proxy")
      expect(content).toContain('"options": {}')
    } finally {
      restoreEnv("XDG_CONFIG_HOME", prev)
    }
  })

  it("ignores ancestor configs that do not include the plugin", async () => {
    const work = await fs.mkdtemp(path.join(os.tmpdir(), "jsonc-skip-"))
    const proj = path.join(work, "proj")
    await fs.mkdir(proj, { recursive: true })
    await fs.writeFile(path.join(proj, "opencode.json"), '{ "plugins": ["other-plugin"] }')
    const cfgHome = path.join(work, "xdg")
    const prev = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = cfgHome
    try {
      const found = await findPluginConfigFile(proj)
      expect(found).toBe(path.join(cfgHome, "opencode", "opencode.json"))
    } finally {
      restoreEnv("XDG_CONFIG_HOME", prev)
    }
  })
})

function longestCommonPrefixSuffix(a: string, b: string) {
  let p = 0
  while (p < a.length && p < b.length && a[p] === b[p]) p++
  let s = 0
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++
  return {
    prefix: a.slice(0, p),
    suffix: a.slice(a.length - s),
    changedOld: a.slice(p, a.length - s),
    changedNew: b.slice(p, b.length - s),
  }
}

function optsNode(text: string): Node {
  const tree = parseTree(text)
  if (!tree) throw new Error("fixture did not parse")
  const pluginsProp = tree.children?.find(
    (c) => c.type === "property" && c.children?.[0]?.value === "plugins",
  )
  const arr = pluginsProp?.children?.[1]
  const entry = arr?.children?.[0]
  const optProp = entry?.children?.find(
    (c) => c.type === "property" && c.children?.[0]?.value === "options",
  )
  const node = optProp?.children?.[1]
  if (!node) throw new Error("options node not found")
  return node
}

function entryNode(text: string, index: number): Node {
  const tree = parseTree(text)
  if (!tree) throw new Error("fixture did not parse")
  const pluginsProp = tree.children?.find(
    (c) => c.type === "property" && c.children?.[0]?.value === "plugins",
  )
  const arr = pluginsProp?.children?.[1]
  const entry = arr?.children?.[index]
  if (!entry) throw new Error("plugin entry not found")
  return entry
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}
