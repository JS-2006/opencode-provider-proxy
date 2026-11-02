**opencode-provider-proxy**  
Плагин для [OpenCode v2, который направляет трафик **выбранных провайдеров** через настроенные forward-прокси (**HTTP CONNECT / SOCKS5**, с опциональной авторизацией). Провайдеры, не указанные в конфигурации, работают как раньше — напрямую.](https://opencode.ai/v2/docs/ "https://opencode.ai/v2/docs/")  
Плагин полезен, когда часть провайдеров доступна только через прокси (например, региональные ограничения), а остальные должны ходить напрямую.  
**Возможности**  
- **Точечная маршрутизация**: карта «провайдер → прокси» задаётся в конфиге OpenCode.  
- **Поддержка HTTP CONNECT и SOCKS5** (с аутентификацией `username`/`password`).  
- **HTTPS через прокси** выполняется с проверкой сертификата и hostname (через `openssl s_client -verify_return_error -verify_hostname`).  
- **Без зависимости от переменных окружения** `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`: выбор прокси управляется только конфигурацией плагина.  
- **Горячая перезагрузка**: изменения конфига (`opencode.json(c)`) применяются без перезапуска OpenCode.  
- **TUI-панель и RPC**: назначать прокси можно прямо из интерфейса (`Ctrl+G` / `/proxy-setup`), изменения записываются в конфиг на диске.  
- **Стриминг**: тела запросов и ответов передаются потоково, включая chunked-ответы.  
- **Изоляция**: провайдеры вне карты маршрутов не трогаются вообще.  
**Как это работает**  
**Архитектура**  
```  
         OpenCode (server, Bun)  
  ┌────────────────────────────────────────────┐  
  │  provider:my-provider                       │  
  │    settings.baseURL = http://127.0.0.1:PORT/my-provider/v1  
  │    settings.transport = "http"             │  
  └───────────────┬────────────────────────────┘  
                  │  HTTP-запрос  
                  ▼  
  ┌────────────────────────────────────────────┐  
  │  Локальный gateway (порт 127.0.0.1:PORT)   │  
  │  src/gateway.ts                            │  
  │                                            │  
  │  route: /my-provider/v1/*  →  upstream:    │  
  │    https://api.example.com/v1/*             │  
  └───────────────┬────────────────────────────┘  
                  │  CONNECT / SOCKS5 / TLS  
                  ▼  
  ┌────────────────────────────────────────────┐  
  │  Прокси (например 127.0.0.1:10808)         │  
  └───────────────┬────────────────────────────┘  
                  │  туннель  
                  ▼  
         Реальный API провайдера  
   
```  
1. **Серверная часть** (`src/index.ts`) при старте запускает локальный HTTP-gateway на `127.0.0.1` (случайный порт).  
2. Для каждого провайдера из `options.providers` плагин переписывает его `settings.baseURL` на gateway и принудительно ставит `settings.transport: "http"`. **Путь оригинального baseURL сохраняется**: например, `https://api.example.com/v1` → `http://127.0.0.1:PORT/my-provider/v1`.  
3. Gateway принимает запрос, снимает префикс `/my-provider`, восстанавливает оригинальный upstream-URL и передаёт запрос через прокси.  
4. Если провайдер не указан в настройках — его `baseURL` не меняется, трафик идёт как обычно.  
**Транспорт прокси**  
Для HTTP-прокси используется рукопожатие `CONNECT` (с `Proxy-Authorization: Basic`, если заданы креды), затем обычный HTTP/1.1-обмен поверх туннеля. Для SOCKS5 выполняется полное рукопожатие (greeting → auth → connect).  
HTTPS-цели (upstream с `https://`) через HTTP-прокси оборачиваются в TLS при помощи `openssl s_client -proxy`: Bun не поддерживает надёжно `tls.connect({ socket })` поверх готового CONNECT-туннеля, поэтому handshake делегируется `openssl` с проверкой цепочки сертификатов и hostname. Это требует наличия `openssl` в `PATH` (см. [Требования).](#anchor-1 "#anchor-1")  
*⚠️ HTTPS через* ***SOCKS5***-*прокси не поддерживается (openssl умеет `-proxy` только для HTTP CONNECT). Для HTTPS-апстримов используйте HTTP CONNECT-прокси.*  
**Требования**  
- **OpenCode v2** (проверялось на `2.2.5`, сервер работает на Bun).  
- **Node.js 20+** — для разработки и тестов (сам плагин исполняется Bun'ом внутри OpenCode).  
- **openssl** (обычно есть в системе; на Arch: `openssl` из `openssl` package).  
- Прокси: любой HTTP CONNECT или SOCKS5 forward-прокси.  
**Установка**  
Плагин не опубликован в npm; ставьте его локальным путём.  

### Скачивание из репозитория

Клонируйте репозиторий в удобное место, например:

```bash
git clone https://github.com/<owner>/opencode-provider-proxy.git ~/projects/opencode-provider-proxy
# либо, если репозиторий доступен по SSH:
git clone git@github.com:<owner>/opencode-provider-proxy.git ~/projects/opencode-provider-proxy
```

Также можно просто скопировать директорию проекта (например, из уже существующего локального клона: `rsync -a --exclude node_modules --exclude .git /путь/к/плагину/ ~/projects/opencode-provider-proxy/`).

### Подготовка окружения («сборка»)

Плагин **не требует компиляции** для работы в OpenCode v2: он загружается напрямую из исходников (TypeScript) сервером на Bun. Никаких шагов сборки для установки не нужно.

Шаг `npm install` нужен только для **локальной разработки** — запуска тестов и проверки типов:

```bash
cd ~/projects/opencode-provider-proxy
npm install          # установка dev-зависимостей (vitest, typescript, ...)
npm run typecheck    # проверка типов (tsc --noEmit)
npm test             # прогон тестов (vitest)
```

Если всё прошло без ошибок (тесты зелёные, typecheck чистый) — плагин готов к подключению, описанному ниже.

### Вариант A. Глобально (для всех проектов)

После получения кода (см. [Скачивание из репозитория](#скачивание-из-репозитория)) добавьте запись в глобальный конфиг `~/.config/opencode/opencode.json(c)` (этот файл может быть JSON или JSONC; комментарии допускаются только в `opencode.jsonc`):  
```  
{  
   "$schema": "https://opencode.ai/config.json",  
   "plugins": [  
     {  
       "package": "/home/<user>/projects/opencode-provider-proxy",  
       "options": {  
         "proxies": {  
           "local-http": { "url": "http://127.0.0.1:10808" }  
         },  
         "providers": {  
           "my-provider": { "proxy": "local-http" },  
           "another-provider": { "proxy": "local-http" }  
         }  
       }  
     }  
   ]  
 }  
  
```
Путь `package` — абсолютный путь к директории с `package.json` плагина.  
**Вариант B. Локально (для конкретного проекта)**  
Два способа:  
1. **Автоматическое обнаружение.** Положите плагин в `.opencode/plugins/` проекта:

   ```text
   <проект>/.opencode/
     plugins/
       provider-proxy/   # копия репозитория или symlink
   ```

   Плагины из `.opencode/plugins/` загружаются автоматически, без правки конфига.

2. **Явная ссылка в конфиге проекта** (`opencode.json(c)` в корне проекта или `.opencode/opencode.json(c)`):

   ```jsonc
   {
     "plugins": [
       {
         "package": "../shared/opencode-provider-proxy",
         "options": { /* ... */ }
       }
     ]
   }
   ```
   ```

**Проверка установки**  
Конфиг подхватывается автоматически (watcher). Проверьте, что плагин активен:  
```  
opencode api get /api/plugin  
   
```  
В списке должен появиться плагин `provider-proxy` со статусом `active`. В логах (`~/.local/share/opencode/log/opencode.log`) должна быть строка вида:  
```  
provider-proxy: active, gateway on 127.0.0.1:PORT, routes=2  
   
```  
Если статус `failed` — смотрите раздел [Устранение неполадок.](#anchor-2 "#anchor-2")  
**Настройка**  
Все настройки лежат в `options` записи плагина в `opencode.json(c)`.  
**Схема options**  
  
|  |  |  |  
| - | - | - |  
| **Ключ** |  **Тип** |  **Описание** |  
| `proxies` |  объект |  Карта **имя прокси → определение прокси**. |  
| `providers` |  объект |  Карта **id провайдера → имя прокси** из `proxies`. |  
  
   
Определение прокси (`proxies`):  
  
|  |  |  |  
| - | - | - |  
| **Поле** |  **Обязательно** |  **Описание** |  
| `url` |  да |  URL прокси. Схемы: `http://`, `https://`, `socks4://`, `socks5://`. |  
| `username` |  нет |  Логин для авторизации на прокси. |  
| `password` |  нет |  Пароль для авторизации на прокси. |  
  
   
Значение `providers.<id>` может быть:  
- строкой — имя прокси: `"my-provider": "local-http"`;  
- объектом — `{ "proxy": "local-http" }` (эквивалентно; именно эту форму записывает TUI/RPC).  
Провайдер, отсутствующий в `providers` (или с `null`), остаётся «напрямую».  
**Пример 1. HTTP CONNECT-прокси на 127.0.0.1:10808**  
```  
{  
   "$schema": "https://opencode.ai/config.json",  
   "plugins": [  
     {  
       "package": "/home/user/projects/opencode-provider-proxy",  
       "options": {  
         "proxies": {  
           "local-http": {  
             "url": "http://127.0.0.1:10808"  
           }  
         },  
         "providers": {  
           "my-provider": { "proxy": "local-http" },  
           "another-provider": { "proxy": "local-http" }  
         }  
       }  
     }  
   ]  
 }  
   
```  
**Пример 2. Корпоративный прокси с авторизацией**  
```  
"proxies": {  
   "corp": {  
     "url": "http://corp-proxy.example.com:8080",  
     "username": "ivanov",  
     "password": "s3cret"  
   },  
   "corp-socks": {  
     "url": "socks5://socks.corp.example.com:1080",  
     "username": "ivanov",  
     "password": "s3cret"  
   }  
 },  
 "providers": {  
   "my-provider": { "proxy": "corp" },  
   "another-provider": { "proxy": "corp-socks" }  
 }  
   
```  
**Переменные окружения**  
В `url` (и вообще в любом значении строк) поддерживаются плейсхолдеры `${VAR}`: они заменяются на значение `process.env.VAR` в момент построения маршрута. Если переменная не задана — подставляется пустая строка и печатается предупреждение в лог.  
```  
"proxies": {  
   "corp": { "url": "http://${CORP_PROXY_HOST}:${CORP_PROXY_PORT}" }  
 }  
   
```  
**Что происходит с провайдером**  
Для каждого маршрутизированного провайдера плагин:  
- меняет `settings.baseURL` на `http://127.0.0.1:PORT/<providerId><путь из оригинального baseURL>`;  
- ставит `settings.transport: "http"`.  
Это видно в API (см. [Проверка). Например, для `my-provider` с оригинальным `https://api.example.com/v1` станет `http://127.0.0.1:34505/my-provider/v1`.](#anchor-3 "#anchor-3")  
**Динамическая настройка: TUI и RPC**  
- Откройте панель **Provider Proxy**: палитра `Ctrl+G` или слеш-команда `/proxy-setup`.  
- Кнопка по провайдеру открывает диалог выбора прокси из всех `proxies` + **Direct** (снимает назначение).  
- Панель сохраняет изменения в конфиг через RPC `updateSettings` и пересобирает gateway **без перезапуска** OpenCode.  
- **Креды прокси никогда не покидают сервер**: в TUI передаётся только булев `auth` флаг, не пароль.  
**Проверка работы**  
1. Убедитесь, что маршруты применились:  
2.   
```  
opencode api get /api/provider  
   
```  
3. У `my-provider`/`another-provider` должен быть `baseURL` вида `http://127.0.0.1:PORT/...`, у остальных — оригинальный.  
4. Отправьте запрос к провайдеру через прокси:  
5.   
```  
opencode run -m my-provider/my-model "Скажи: OK"  
   
```  
6. Успешный ответ модели означает, что цепочка gateway → прокси → upstream работает.  
7. Убедитесь, что соединение действительно идёт через прокси (опционально):  
8.   
```  
ss -tnp | grep '127.0.0.1:10808'  
   
```  
9. Во время запроса появятся ESTAB-соединения от процессов OpenCode/openssl к порту прокси.  
10. Проверьте логи:  
11.   
```  
grep "provider-proxy:" ~/.local/share/opencode/log/opencode.log  
   
```  
**Устранение неполадок**  
  
|  |  |  
| - | - |  
| **Симптом** |  **Причина / решение** |  
| Плагин `failed` в `/api/plugin` |  Смотрите лог `~/.local/share/opencode/log/opencode.log`: причина обычно в ошибке импорта или в опциях. Также проверьте, что путь `package` корректен и содержит `package.json` с `exports`. |  
| `proxy_error` в ответе провайдера |  Это ошибка *старой* реализации (fetch/proxy-agent). В текущей версии транспорт сырых сокетов не использует `proxy-agent`; если `proxy_error` появился — вероятно, сервер OpenCode использует устаревший код плагина (перезагрузите: сохраните конфиг или `/reload`). |  
| Ошибка `Invalid URL` |  В конфиге `url` прокси или upstream-адрес составлен неверно (например, забыт слэш). Проверьте `proxies[].url` и `providers`. |  
| `404` от API провайдера |  Путь не сохранился: убедитесь, что upstream `baseURL` провайдера содержит путь (например `/v1`), и что `/api/provider` показывает его в `baseURL` gateway (например `.../my-provider/v1`). |  
| `upstream body idle timeout` / зависание |  Upstream не шлёт `Content-Length`/`Transfer-Encoding` и держит соединение открытым. Для нефреймленных тел применяется idle-таймаут 2 с; для реальных API (всегда с CL/TE) это не влияет. |  
| Ошибка TLS `SSL routines` при HTTPS через прокси |  Проверьте, что установлен `openssl` и доступен в `PATH`. Убедитесь, что прокси — HTTP CONNECT (а не SOCKS), для HTTPS-апстримов. |  
| `CONNECT failed with status ...` |  Прокси отверг туннель (часто требуется авторизация). Добавьте `username`/`password` в определение прокси. |  
| Изменения конфига не применяются |  Откройте панель `/proxy-setup` или сохраните файл ещё раз; watcher перечитывает конфиг автоматически. При упорных проблемах — `/reload`. |  
  
   
**Ограничения**  
- **Проксируется только API-трафик провайдеров** (через `baseURL`). Discovery, OAuth refresh, MCP-соединения и прочий сервисный трафик идёт напрямую.  
- **WebSocket-транспорт отключён для маршрутизированных провайдеров** (принудительно `transport: "http"`).  
- **HTTPS через SOCKS5 не поддерживается** — используйте HTTP CONNECT для HTTPS-апстримов.  
- **Добавление нового прокси из TUI-панели не поддерживается** (только выбор среди уже существующих в `proxies`). Новые прокси добавляются правкой конфига.  
- Прокси-креды не логируются и не возвращаются наружу (в TUI/API — только флаг `auth`).  
**Разработка**  
```  
npm install          # установка зависимостей  
 npm test             # vitest (53 теста)  
 npm run typecheck    # tsc --noEmit  
   
```  
Структура:  
```  
src/  
   index.ts        # точка входа плагина: gateway, маршруты, RPC, подписка на config.updated  
   gateway.ts      # сырой транспорт: CONNECT/SOCKS5, TLS через openssl, chunked-декодер  
   apply.ts        # переписывание settings.baseURL / transport провайдеров  
   config.ts       # нормализация и валидация options  
   upstream.ts     # построение upstream-URL из пути запроса  
   rpc.ts          # RPC-контракт (getSettings / updateSettings)  
   tui.tsx         # TUI-панель (Ctrl+G, /proxy-setup)  
   jsonc-config.ts # чтение/запись options в opencode.json(c)  
 test/             # vitest-тесты (включая интеграционные для gateway)  
   
```  
**Лицензия**  
GNU General Public License v3.0 or later (GPL-3.0-or-later). Полный текст — в файле [LICENSE.](LICENSE "LICENSE")  
