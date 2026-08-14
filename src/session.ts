/**
 * Headless browser session over Playwright: one session wraps a launched
 * chromium, its context, and a single page, plus the text/snapshot extraction
 * the model-facing tools consume.
 *
 * @module dsh-plugin-browser/session
 */

import { Browser, BrowserContext, chromium, Page } from 'playwright'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Session-level configuration resolved once at plugin load. */
export interface BrowserConfig {
  /** Path to a system browser executable. Omit to use Playwright's bundled chromium. */
  executablePath?: string
  /** Navigation/click/type timeout in milliseconds. */
  timeoutMs: number
  /** Cap on characters of extracted body text per snapshot. */
  maxTextChars: number
  /** Cap on links listed per snapshot. */
  maxLinks: number
}

/** The rendered-page projection returned by the navigate and snapshot tools. */
export interface PageSnapshot {
  title: string
  url: string
  text: string
  links: string[]
}

/** Truncate text at a character cap without splitting a surrogate pair. */
function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  let end = maxChars
  while (end > 0 && (text.charCodeAt(end) & 0xfc00) === 0xdc00) end -= 1
  return `${text.slice(0, end)}\n…(truncated)`
}

/** Project a snapshot to model-facing prose. */
export function formatSnapshot(snapshot: PageSnapshot): string {
  const lines = [`Title: ${snapshot.title}`, `URL: ${snapshot.url}`, '', snapshot.text]
  if (snapshot.links.length > 0) {
    lines.push('', 'Links:')
    for (const link of snapshot.links) lines.push(`- ${link}`)
  }
  return lines.join('\n')
}

/**
 * One live headless browser session. Sessions are created lazily and closed
 * explicitly; the owning manager owns their lifecycle.
 */
export class BrowserSession {
  private readonly browser: Browser
  private readonly context: BrowserContext
  private readonly config: BrowserConfig
  private readonly homeDir: string
  readonly page: Page

  private constructor(browser: Browser, context: BrowserContext, page: Page, config: BrowserConfig, homeDir: string) {
    this.browser = browser
    this.context = context
    this.page = page
    this.config = config
    this.homeDir = homeDir
  }

  /** Launch a headless browser and open a fresh page. */
  static async create(config: BrowserConfig): Promise<BrowserSession> {
    // A private HOME keeps the browser fully self-contained: profile, crashpad,
    // and cache all land under this temp dir instead of the user's real profile.
    const homeDir = mkdtempSync(join(tmpdir(), 'dsh-browser-'))
    const browser = await chromium.launch({
      headless: true,
      env: { ...process.env, HOME: homeDir },
      // macOS Chrome hardcodes its crashpad database to the real app-support
      // dir regardless of $HOME; disabling crash reporting and metrics stops
      // it from writing there, keeping the browser fully self-contained.
      args: [
        '--disable-crash-reporter',
        '--disable-metrics-reporting',
        '--no-first-run',
        '--disable-background-networking',
      ],
      ...(config.executablePath !== undefined ? { executablePath: config.executablePath } : {}),
    })
    const context = await browser.newContext()
    const page = await context.newPage()
    return new BrowserSession(browser, context, page, config, homeDir)
  }

  /** Open a URL and wait for its load event. */
  async navigate(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: 'load', timeout: this.config.timeoutMs })
  }

  /** Project the current page's rendered title, body text, and links. */
  async snapshot(): Promise<PageSnapshot> {
    const title = await this.page.title().catch(() => '')
    const text = await this.page.locator('body').innerText().catch(() => '')
    const links = await this.page.locator('a[href]').evaluateAll((anchors) =>
      anchors.map((anchor) => {
        const element = anchor as HTMLAnchorElement
        const label = element.textContent?.trim() ?? ''
        return label.length > 0 ? `${label} → ${element.href}` : element.href
      }))
    return {
      title,
      url: this.page.url(),
      text: truncate(text, this.config.maxTextChars),
      links: links.slice(0, this.config.maxLinks),
    }
  }

  /** Wait for a visible element and click it. */
  async click(selector: string): Promise<void> {
    const locator = this.page.locator(selector)
    await locator.waitFor({ state: 'visible', timeout: this.config.timeoutMs })
    await locator.click({ timeout: this.config.timeoutMs })
  }

  /** Wait for an element and fill it with text. */
  async type(selector: string, text: string): Promise<void> {
    const locator = this.page.locator(selector)
    await locator.waitFor({ state: 'visible', timeout: this.config.timeoutMs })
    await locator.fill(text, { timeout: this.config.timeoutMs })
  }

  /** Capture the current viewport as a PNG at the given path. */
  async screenshot(path: string): Promise<void> {
    await this.page.screenshot({ path, timeout: this.config.timeoutMs })
  }

  /** Close the browser and release its resources. */
  async close(): Promise<void> {
    await this.browser.close().catch(() => {})
    rmSync(this.homeDir, { recursive: true, force: true })
  }
}

/**
 * Lazily-created per-agent browser sessions. An `exec.agent` key isolates one
 * session per agent; calls without an agent share a default session. Disposal
 * closes every live session so plugin unload never leaks a browser process.
 */
export class BrowserSessionManager {
  private readonly config: BrowserConfig
  private readonly sessions = new WeakMap<object, BrowserSession>()
  private readonly live = new Set<BrowserSession>()
  private defaultSession: BrowserSession | undefined

  constructor(config: BrowserConfig) {
    this.config = config
  }

  /** Resolve (creating if needed) the session for one agent key. */
  async requireSession(key?: object): Promise<BrowserSession> {
    if (key !== undefined) {
      const existing = this.sessions.get(key)
      if (existing !== undefined) return existing
      const created = await this.createSession()
      this.sessions.set(key, created)
      return created
    }
    this.defaultSession ??= await this.createSession()
    return this.defaultSession
  }

  /** Close the session for one agent key (or the default when key is absent). */
  async closeSession(key?: object): Promise<boolean> {
    let session: BrowserSession | undefined
    if (key !== undefined) {
      session = this.sessions.get(key)
      if (session !== undefined) this.sessions.delete(key)
    } else {
      session = this.defaultSession
      this.defaultSession = undefined
    }
    if (session === undefined) return false
    this.live.delete(session)
    await session.close()
    return true
  }

  /** Close every live session. */
  async dispose(): Promise<void> {
    const sessions = [...this.live]
    this.live.clear()
    this.defaultSession = undefined
    await Promise.all(sessions.map(session => session.close()))
  }

  private async createSession(): Promise<BrowserSession> {
    const session = await BrowserSession.create(this.config)
    this.live.add(session)
    return session
  }
}
