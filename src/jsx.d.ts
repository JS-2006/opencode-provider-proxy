import type { JSX as OpenTUIJSX } from "@opentui/solid"

/**
 * With `jsx: "preserve"` the compiler resolves JSX element types against the
 * ambient (global) `JSX` namespace rather than a per-module one. This project
 * has no React types, so we surface OpenTUI's Solid JSX namespace as the global
 * one for the plugin's TUI components.
 */
declare global {
  namespace JSX {
    type Element = OpenTUIJSX.Element
    interface IntrinsicElements extends OpenTUIJSX.IntrinsicElements {}
    interface ElementChildrenAttribute {
      children: {}
    }
  }
}

export {}
