# dsh-plugin-browser

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) community plugin that drives a **headless browser** with Playwright. It registers six model-callable tools that let the model read JavaScript-rendered pages, take screenshots, and automate page interactions — the capabilities the built-in `web_fetch` (plain HTTP) cannot provide.

## Tools

| Tool | What it does |
|---|---|
| `browser_navigate(url)` | Open a URL, wait for load, return rendered title, body text, and links |
| `browser_snapshot()` | Return the current page's rendered text (use between automation steps) |
| `browser_click(selector)` | Click an element (any Playwright CSS selector) |
| `browser_type(selector, text)` | Fill a text input |
| `browser_screenshot(path?)` | Save a viewport PNG; defaults to `browser-<timestamp>.png` in `screenshotDir` |
| `browser_close()` | Close the current browser session and release resources |

Each agent gets its own isolated browser session; calls without an agent share a default session. Sessions start lazily on first use and close when the plugin unloads.

## Install

The plugin uses Playwright's bundled chromium by default. First-time setup installs the browser binary:

```sh
dsh plugin --profile demo add github:you/dsh-plugin-browser
npx playwright install chromium   # from the profile directory
```

Then boot and ask the model, for example: *"Open https://example.com and tell me what's on the page."* The model calls `browser_navigate` and receives the rendered text.

## Configure

Override the row in the profile's `cordis.patch.yml`:

```yaml
- id: browser
  name: dsh-plugin-browser
  config:
    timeoutMs: 30000      # navigation/click/type timeout
    maxTextChars: 20000   # cap on extracted body text per snapshot
    maxLinks: 20          # cap on links listed per snapshot
    screenshotDir: .      # default directory for screenshots
    executablePath: /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
```

`executablePath` points at a system browser instead of Playwright's bundled chromium — useful when you do not want the browser download.

## Development

```sh
pnpm install
pnpm run typecheck
pnpm run build     # emits lib/index.js and lib/index.d.ts
pnpm run test
```

The test suite boots a local HTTP server and drives the **system Chrome** (skipped when Chrome is absent), so it needs no browser download and no real network. With Playwright's bundled chromium instead, install it once: `npx playwright install chromium`.

## Structure

```
browser/
├── package.json       # bundle manifest (dsh.bundle), scripts, deps
├── cordis.patch.yml   # the configuration layer the bundle inserts
├── src/index.ts       # plugin: name / inject / Config / apply
├── src/session.ts     # headless session + per-agent session manager
├── src/tools.ts       # the six tool definitions
├── tests/browser.spec.ts
├── tsconfig.json
└── vitest.config.ts
```

## License

[MIT](LICENSE)
