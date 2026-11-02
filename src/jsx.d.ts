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
