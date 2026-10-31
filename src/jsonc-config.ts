import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  applyEdits,
  modify,
  parse,
  parseTree,
  type JSONPath,
  type Node,
} from "jsonc-parser"

export const PLUGIN_NAMES = ["opencode-provider-proxy", "provider-proxy"]

const CONFIG_FILENAMES = ["opencode.json", "opencode.jsonc"]

const DEFAULT_CONFIG = `{
  "plugins": [
    { "package": "opencode-provider-proxy", "options": {} }
  ]
}
`

/**
 * Walk upward from `startDir` looking for an opencode.json/opencode.jsonc that
 * registers this plugin. Returns the closest matching file, or falls back to
 * the user-global config (creating it with a default plugin entry if absent).
 */
export async function findPluginConfigFile(
  startDir: string,
): Promise<string | undefined> {
  let dir = path.resolve(startDir)
  for (;;) {
    for (const name of CONFIG_FILENAMES) {
      const candidate = path.join(dir, name)
      if (await isFile(candidate)) {
        const text = await fs.readFile(candidate, "utf8")
        if (docHasPlugin(parse(text))) return candidate
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return ensureGlobalConfig()
}

/**
 * Update the `options` of this plugin's entry inside `file`. Uses
 * jsonc-parser's parseTree/modify/applyEdits so comments and formatting outside
 * the edited range are preserved byte-for-byte. The file is rewritten
 * atomically (tmp + rename).
 */
export async function updatePluginOptions(
  file: string,
  options: unknown,
): Promise<void> {
  const text = await fs.readFile(file, "utf8")
  const updated = editConfigText(text, options)
  await atomicWrite(file, updated)
}

/**
 * Read the current `options` of this plugin's entry from the config file
 * closest to `startDir`, or return `undefined` when no such entry exists. This
 * is the authoritative, freshly-read state (used by `config.updated` rebuilds
 * so they never act on a stale in-memory options snapshot).
 */
export async function readPluginOptions(
  startDir: string,
): Promise<unknown | undefined> {
  const file = await findPluginConfigFile(startDir)
  if (!file) return undefined
  const text = await fs.readFile(file, "utf8")
  return extractPluginOptions(parse(text))
}

function extractPluginOptions(doc: unknown): unknown | undefined {
  if (
    typeof doc !== "object" ||
    doc === null ||
    Array.isArray(doc)
  ) {
    return undefined
  }
  const plugins = (doc as Record<string, unknown>).plugins
  if (!Array.isArray(plugins)) return undefined
  for (const entry of plugins) {
    if (
      typeof entry === "object" &&
      entry !== null &&
      !Array.isArray(entry)
    ) {
      const pkg = (entry as Record<string, unknown>).package
      if (
        typeof pkg === "string" &&
        (PLUGIN_NAMES.includes(pkg) ||
          PLUGIN_NAMES.includes(path.basename(pkg)))
      ) {
        const opts = (entry as Record<string, unknown>).options
        if (typeof opts === "object" && opts !== null && !Array.isArray(opts)) {
          return opts
        }
        return undefined
      }
    }
  }
  return undefined
}

function editConfigText(text: string, options: unknown): string {
  const tree = parseTree(text)
  if (!tree) throw new Error("Could not parse JSONC config")

  const pluginsNode = propertyValueNode(tree, "plugins")
  if (!pluginsNode || pluginsNode.type !== "array") {
    return applyEdits(
      text,
      modify(
        text,
        ["plugins"],
        [{ package: "opencode-provider-proxy", options }],
        {},
      ),
    )
  }

  const idx = pluginIndex(pluginsNode)
  if (idx < 0) {
    const path: JSONPath = ["plugins", pluginsNode.children?.length ?? 0]
    return applyEdits(
      text,
      modify(
        text,
        path,
        { package: "opencode-provider-proxy", options },
        { isArrayInsertion: true },
      ),
    )
  }

  const element = pluginsNode.children?.[idx]
  // A matched entry in string form (e.g. "opencode-provider-proxy" or
  // "./plugins/provider-proxy") cannot carry an `options` node. Convert it to
  // object form, preserving the original package value.
  if (element?.type === "string") {
    return applyEdits(
      text,
      modify(
        text,
        ["plugins", idx],
        { package: element.value as string, options },
        {},
      ),
    )
  }

  const path: JSONPath = ["plugins", idx, "options"]
  return applyEdits(text, modify(text, path, options, {}))
}

function pluginIndex(pluginsNode: Node): number {
  const elements = pluginsNode.children ?? []
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i]
    if (el.type === "string") {
      if (PLUGIN_NAMES.includes(path.basename(el.value as string))) return i
    } else if (el.type === "object") {
      const pkgNode = propertyValueNode(el, "package")
      const pkg = pkgNode?.value
      if (
        typeof pkg === "string" &&
        (PLUGIN_NAMES.includes(pkg) ||
          PLUGIN_NAMES.includes(path.basename(pkg)))
      ) {
        return i
      }
    }
  }
  return -1
}

function propertyValueNode(obj: Node, key: string): Node | undefined {
  if (obj.type !== "object") return undefined
  for (const child of obj.children ?? []) {
    if (child.type !== "property") continue
    if (child.children?.[0]?.value === key) return child.children?.[1]
  }
  return undefined
}

function docHasPlugin(doc: unknown): boolean {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return false
  const plugins = (doc as Record<string, unknown>).plugins
  if (!Array.isArray(plugins)) return false
  for (const entry of plugins) {
    if (typeof entry === "string") {
      if (PLUGIN_NAMES.includes(path.basename(entry))) return true
    } else if (
      typeof entry === "object" &&
      entry !== null &&
      !Array.isArray(entry)
    ) {
      const pkg = (entry as Record<string, unknown>).package
      if (
        typeof pkg === "string" &&
        (PLUGIN_NAMES.includes(pkg) ||
          PLUGIN_NAMES.includes(path.basename(pkg)))
      ) {
        return true
      }
    }
  }
  return false
}

async function ensureGlobalConfig(): Promise<string> {
  const file = await globalConfigPath()
  if (!(await isFile(file))) {
    await fs.mkdir(path.dirname(file), { recursive: true })
    try {
      await fs.writeFile(file, DEFAULT_CONFIG, { encoding: "utf8", flag: "wx" })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
    }
  }
  return file
}

async function globalConfigPath(): Promise<string> {
  const xdg = process.env.XDG_CONFIG_HOME
  const base =
    xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".config")
  return path.join(base, "opencode", "opencode.json")
}

async function atomicWrite(file: string, content: string): Promise<void> {
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.tmp`,
  )
  await fs.writeFile(tmp, content, "utf8")
  try {
    await fs.rename(tmp, file)
  } catch (err) {
    await fs.rm(tmp, { force: true })
    throw err
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile()
  } catch {
    return false
  }
}
