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

import { Plugin, usePlugin } from "@opencode/plugin/tui"
import {
  For,
  Show,
  createRoot,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js"
import { ProviderProxy } from "./rpc.js"
import type { ProxyTarget } from "./config.js"

interface ProxyInfo {
  name: string
  url: string
  auth: boolean
}

interface ProviderMapping {
  id: string
  proxy: string | null
}

interface Settings {
  active: boolean
  proxies: ProxyInfo[]
  providers: ProviderMapping[]
}

const DIRECT_LABEL = "Напрямую"

function ProxyPage() {
  const context = usePlugin()
  const rpc = context.client.rpc(ProviderProxy)

  const [settings, setSettings] = createSignal<Settings>({
    active: false,
    proxies: [],
    providers: [],
  })
  const [busy, setBusy] = createSignal(false)

  async function refresh() {
    try {
      setSettings((await rpc.getSettings({})) as Settings)
    } catch {
      context.ui.toast.show({
        title: "Ошибка",
        message: "Не удалось получить настройки прокси",
        variant: "error",
      })
    }
  }

  let disposeEvents: (() => void) | undefined
  onMount(() => {
    void refresh()
    disposeEvents = rpc.events.on("updated", () => {
      void refresh()
    })
  })
  onCleanup(() => {
    disposeEvents?.()
  })

  async function changeProxy(providerId: string) {
    const current = settings()
    const options: Array<{ title: string; value: string | null }> = [
      ...current.proxies.map((p) => ({ title: p.name, value: p.name })),
      { title: DIRECT_LABEL, value: null },
    ]
    const selected = await context.ui.dialog.select<string | null>({
      title: "Прокси для провайдера",
      options,
    })
    if (selected === undefined) return

    // The server replaces the whole provider table from the update payload, so
    // send the full current map with only this provider changed, preserving the
    // other mappings.
    const nextProviders: Record<string, string | null> = {}
    for (const p of current.providers) {
      nextProviders[p.id] = p.proxy
    }
    nextProviders[providerId] = selected

    setBusy(true)
    try {
      await rpc.updateSettings({ providers: nextProviders })
      await refresh()
      context.ui.toast.show({
        message: "Маппинг провайдера обновлён",
        variant: "success",
      })
    } catch {
      context.ui.toast.show({
        title: "Ошибка",
        message: "Не удалось обновить маппинг провайдера",
        variant: "error",
      })
    } finally {
      setBusy(false)
    }
  }

  async function addProxy() {
    const url = await context.ui.dialog.prompt({
      title: "Добавить прокси",
      description: "URL прокси (http://, https://, socks4://, socks5://)",
      placeholder: "http://proxy.example.com:8080",
    })
    if (!url) return

    const username = await context.ui.dialog.prompt({
      title: "Логин (необязательно)",
      description: "Логин для авторизации на прокси, или пусто",
    })
    const password =
      username !== undefined && username !== ""
        ? await context.ui.dialog.prompt({
            title: "Пароль (необязательно)",
            description: "Пароль для авторизации на прокси, или пусто",
          })
        : undefined

    const target: ProxyTarget = { url }
    if (username) target.username = username
    if (password) target.password = password

    // The approved RPC contract's `updateSettings` accepts only a providers map
    // and cannot persist new proxy table entries, so a freshly added proxy
    // cannot be written through the panel. Documented limitation for a follow-up.
    context.ui.toast.show({
      title: "Ограничение",
      message: `Добавление новых прокси через панель пока не поддерживается (рассмотрено: ${target.url}). Добавьте прокси в конфиг плагина.`,
      variant: "warning",
    })
  }

  return (
    <box flexDirection="column" padding={1} gap={1}>
      <b>Прокси провайдеров</b>

      <box flexDirection="column" gap={1}>
        <For each={settings().providers}>
          {(provider) => (
            <box
              flexDirection="row"
              gap={1}
              onMouseUp={() => void changeProxy(provider.id)}
            >
              <text width={48}>{provider.id}</text>
              <text>{provider.proxy ?? DIRECT_LABEL}</text>
            </box>
          )}
        </For>
        <Show when={settings().providers.length === 0}>
          <text>Нет провайдеров</text>
        </Show>
      </box>

      <box
        flexDirection="row"
        onMouseUp={() => void addProxy()}
        marginTop={1}
      >
        <b>＋ Добавить прокси</b>
      </box>
      <Show when={busy()}>
        <text>Обновление…</text>
      </Show>
    </box>
  )
}

export default Plugin.define({
  id: "provider-proxy.cli",
  setup(context) {
    const unregister = context.ui.router.register({
      name: "provider-proxy",
      render: () => <ProxyPage />,
    })

    // Own the keymap layer in an explicit root so it can be disposed on cleanup.
    // The keymap provider may be absent in some hosts (e.g. headless/remote
    // TUI); in that case skip the palette command instead of failing setup.
    let disposeLayer: (() => void) | undefined
    if (context.keymap && typeof context.keymap.layer === "function") {
      try {
        createRoot((dispose) => {
          disposeLayer = dispose
          context.keymap.layer(() => ({
            commands: [
              {
                id: "provider-proxy.open",
                title: "Прокси провайдеров",
                group: "Provider Proxy",
                bind: "ctrl+g",
                palette: true,
                slash: { name: "proxy-setup" },
                run: () =>
                  context.ui.router.navigate({
                    type: "plugin",
                    name: "provider-proxy",
                  }),
              },
            ],
          }))
        })
      } catch (err) {
        console.warn("provider-proxy: keymap layer unavailable, skipping palette command", err)
        disposeLayer = undefined
      }
    }

    return () => {
      unregister()
      disposeLayer?.()
    }
  },
})
