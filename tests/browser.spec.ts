import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { chromium } from 'playwright'
import { apply, Config, inject, name } from '../src/index.ts'

// Prefer Playwright's bundled chromium (the real user path, installed with
// `playwright install chromium`); fall back to the system Chrome; skip the
// suite when neither is available.
const SYSTEM_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const bundledPath = chromium.executablePath()
const executablePath = existsSync(bundledPath)
  ? undefined
  : existsSync(SYSTEM_CHROME)
    ? SYSTEM_CHROME
    : undefined

const testSignal = new AbortController().signal

type PluginFiber = Awaited<ReturnType<Context['plugin']>>

let ctx: Context | undefined
let fiber: PluginFiber | undefined
let server: Server
let base: string
let SHOT_DIR: string

describe.skipIf(executablePath === undefined && !existsSync(bundledPath))('dsh-plugin-browser', () => {
  beforeAll(async () => {
    SHOT_DIR = mkdtempSync(join(tmpdir(), 'dsh-browser-'))
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      res.setHeader('content-type', 'text/html; charset=utf-8')
      switch (url.pathname) {
        case '/':
          res.end('<html><head><title>Home</title></head><body><h1>Hello Browser</h1><a href="/about">About</a></body></html>')
          break
        case '/about':
          res.end('<html><head><title>About</title></head><body><p>About page content</p></body></html>')
          break
        case '/form':
          res.end('<html><head><title>Form</title></head><body><form action="/submit" method="get"><input id="name" name="name"><button id="submit" type="submit">Go</button></form></body></html>')
          break
        case '/submit':
          res.end(`<html><head><title>Submitted</title></head><body><p>Hello, ${url.searchParams.get('name') ?? ''}</p></body></html>`)
          break
        default:
          res.statusCode = 404
          res.end('not found')
      }
    })
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve())
    })
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    fiber = await ctx.plugin({ name, inject, Config, apply }, {
      ...(executablePath !== undefined ? { executablePath } : {}),
      timeoutMs: 15000,
      maxTextChars: 20000,
      maxLinks: 20,
      screenshotDir: SHOT_DIR,
    })
  })

  afterAll(async () => {
    // Disposing the plugin fiber runs the effect disposer, which closes the
    // browser session and removes its temp profile.
    await fiber?.dispose()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(SHOT_DIR, { recursive: true, force: true })
  })

  it('navigates a URL and returns its rendered text and links', async () => {
    const result = await ctx!.tools.execute({
      signal: testSignal,
      callId: CallId('c1'),
      name: 'browser_navigate',
      arguments: { url: base },
    })
    expect(result.isError).toBe(false)
    const value = result.value as { title: string; url: string; text: string; links: string[] }
    expect(value.title).toBe('Home')
    expect(value.text).toContain('Hello Browser')
    expect(value.links.some(link => link.includes('/about'))).toBe(true)
  })

  it('clicks a link and reflects the new page', async () => {
    const clicked = await ctx!.tools.execute({
      signal: testSignal,
      callId: CallId('c2'),
      name: 'browser_click',
      arguments: { selector: 'a[href="/about"]' },
    })
    expect(clicked.isError).toBe(false)
    const snapshot = await ctx!.tools.execute({
      signal: testSignal,
      callId: CallId('c3'),
      name: 'browser_snapshot',
      arguments: {},
    })
    const value = snapshot.value as { title: string; text: string }
    expect(value.title).toBe('About')
    expect(value.text).toContain('About page content')
  })

  it('fills a form and submits it', async () => {
    await ctx!.tools.execute({
      signal: testSignal,
      callId: CallId('c4'),
      name: 'browser_navigate',
      arguments: { url: `${base}/form` },
    })
    const typed = await ctx!.tools.execute({
      signal: testSignal,
      callId: CallId('c5'),
      name: 'browser_type',
      arguments: { selector: '#name', text: 'Ada' },
    })
    expect(typed.isError).toBe(false)
    const submitted = await ctx!.tools.execute({
      signal: testSignal,
      callId: CallId('c6'),
      name: 'browser_click',
      arguments: { selector: '#submit' },
    })
    expect(submitted.isError).toBe(false)
    const snapshot = await ctx!.tools.execute({
      signal: testSignal,
      callId: CallId('c7'),
      name: 'browser_snapshot',
      arguments: {},
    })
    expect((snapshot.value as { text: string }).text).toContain('Hello, Ada')
  })

  it('saves a non-empty screenshot', async () => {
    const shot = await ctx!.tools.execute({
      signal: testSignal,
      callId: CallId('c8'),
      name: 'browser_screenshot',
      arguments: {},
    })
    expect(shot.isError).toBe(false)
    const path = String(shot.value)
    expect(existsSync(path)).toBe(true)
    expect(statSync(path).size).toBeGreaterThan(0)
  })

  it('closes the session and starts a fresh one', async () => {
    const closed = await ctx!.tools.execute({
      signal: testSignal,
      callId: CallId('c9'),
      name: 'browser_close',
      arguments: {},
    })
    expect(closed.isError).toBe(false)
    expect((closed.value as { message: string }).message).toBe('browser session closed')
    const reopened = await ctx!.tools.execute({
      signal: testSignal,
      callId: CallId('c10'),
      name: 'browser_navigate',
      arguments: { url: base },
    })
    expect(reopened.isError).toBe(false)
    expect((reopened.value as { title: string }).title).toBe('Home')
  })
})
