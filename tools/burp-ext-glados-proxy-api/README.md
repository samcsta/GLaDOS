# GLaDOS Proxy API — Burp Montoya Extension

Exposes Burp Pro proxy history over a small local HTTP API so the GLaDOS Ops
Dashboard can display traffic and RPS from Burp.

## Why

Burp Pro's built-in REST API (port 1337) only exposes scanning endpoints.
It does **not** serve proxy history. This extension fills that gap with an
in-process HTTP server at **127.0.0.1:1338**.

## Endpoints

| Method | Path               | Params           | Returns |
|--------|--------------------|------------------|---------|
| GET    | `/health`          | —                | `{"ok":true,"buffered":N}` |
| GET    | `/proxy/history`   | `since`, `limit` | JSON array of history entries |
| GET    | `/proxy/rps`       | `window` (sec)   | `{"rps":float,"count":N,"window":sec}` |
| GET    | `/proxy/stream`    | —                | Server-Sent Events, one entry per line |

All responses include `Access-Control-Allow-Origin: *` so the dashboard at
`localhost:4280` can read directly.

## History entry shape

```json
{
  "id": 1234,
  "ts": 1745000000000,
  "method": "GET",
  "url": "https://example.com/foo",
  "host": "example.com",
  "port": 443,
  "secure": true,
  "status": 200,
  "mime": "HTML",
  "reqLen": 512,
  "respLen": 4096,
  "tool": "PROXY",
  "userAgent": "Mozilla/5.0 ...",
  "agentTag": ""
}
```

`agentTag` is populated if the request carried an `X-GLaDOS-Agent` header
(for future per-agent routing).

## Build

```
cd tools/burp-ext-glados-proxy-api
./gradlew shadowJar
```

Output: `build/libs/glados-proxy-api-1.0.0-all.jar`

First build needs internet (Maven Central — Montoya API, NanoHTTPD, Jackson,
Kotlin stdlib). Later builds are offline.

No `gradlew` script yet — bootstrap with a system Gradle (`brew install gradle`)
once, then future builds use the wrapper that Gradle writes on first run.

Actually — simplest path: `gradle wrapper && ./gradlew shadowJar`. After that
the project is self-contained.

## Install in Burp

1. Burp → Extensions → Installed → **Add**.
2. Extension type: **Java**.
3. Extension file: `build/libs/glados-proxy-api-1.0.0-all.jar`.
4. Click Next. Output tab should print `[glados-proxy-api] listening on http://127.0.0.1:1338`.

Verify from terminal:
```
curl -s http://127.0.0.1:1338/health
# {"ok":true,"buffered":0}
```

The extension persists across temp projects (it's loaded at the user level,
not per-project).

## Config via env

Set on the **Burp process** env (open Burp from a shell with these exported):

| Var                  | Default | Meaning                              |
|----------------------|---------|--------------------------------------|
| `GLADOS_EXT_PORT`    | 1338    | HTTP listen port                     |
| `GLADOS_EXT_BUFFER`  | 5000    | Max entries kept in the ring buffer  |

## Uninstall

Burp → Extensions → Installed → select → **Remove**. The embedded HTTP server
shuts down via the extension's unloading handler.
