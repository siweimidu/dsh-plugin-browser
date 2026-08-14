/**
 * Model-facing browser tools over a {@link BrowserSessionManager}. Each tool
 * operates on the calling agent's session (or a shared default session),
 * following the tool DSL contract: typed parameters, one canonical JSON value,
 * and a pure render projection to model prose.
 *
 * @module dsh-plugin-browser/tools
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { resolve } from 'node:path'
import { BrowserSessionManager, formatSnapshot } from './session.ts'

/** Shared execution options for the browser tools. */
export interface BrowserToolsConfig {
  /** The session manager owning browser lifecycle. */
  manager: BrowserSessionManager
  /** Navigation/click/type timeout in milliseconds. */
  timeoutMs: number
  /** Directory where screenshots land when no path is requested. */
  screenshotDir: string
}

/** Resolve the requested screenshot path, defaulting under `screenshotDir`. */
function screenshotPath(config: BrowserToolsConfig, requested?: string): string {
  if (requested !== undefined && requested.trim() !== '') return resolve(requested)
  return resolve(config.screenshotDir, `browser-${Date.now()}.png`)
}

/** Register every browser tool; callers dispose through the tool registry. */
export function browserTools(config: BrowserToolsConfig): ToolDefinition[] {
  const manager = config.manager
  return [
    defineTool({
      name: 'browser_navigate',
      description: 'Open a URL in the headless browser, wait for the page to load, and return its rendered text: title, body text, and links.',
      parameters: {
        url: { type: 'string', required: true, description: 'The absolute URL to open' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string', required: true },
            url: { type: 'string', required: true },
            text: { type: 'string', required: true },
            links: { type: 'array', items: { type: 'string' }, required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: formatSnapshot(value) }],
      },
      timeoutMs: config.timeoutMs,
      async execute(args, exec) {
        const session = await manager.requireSession(exec.agent)
        await session.navigate(args.url)
        return await session.snapshot()
      },
    }),
    defineTool({
      name: 'browser_snapshot',
      description: 'Return the current page as rendered text: title, body text, and links. Use it between automation steps to see the page state.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string', required: true },
            url: { type: 'string', required: true },
            text: { type: 'string', required: true },
            links: { type: 'array', items: { type: 'string' }, required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: formatSnapshot(value) }],
      },
      timeoutMs: config.timeoutMs,
      async execute(_args, exec) {
        const session = await manager.requireSession(exec.agent)
        return await session.snapshot()
      },
    }),
    defineTool({
      name: 'browser_click',
      description: 'Click an element on the current page. The selector is any Playwright CSS selector.',
      parameters: {
        selector: { type: 'string', required: true, description: 'A CSS selector targeting the element to click' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            message: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.message }],
      },
      timeoutMs: config.timeoutMs,
      async execute(args, exec) {
        const session = await manager.requireSession(exec.agent)
        await session.click(args.selector)
        return { ok: true, message: `clicked "${args.selector}"` }
      },
    }),
    defineTool({
      name: 'browser_type',
      description: 'Fill a text input on the current page with the given value. The selector is any Playwright CSS selector.',
      parameters: {
        selector: { type: 'string', required: true, description: 'A CSS selector targeting the input to fill' },
        text: { type: 'string', required: true, description: 'The text to type into the input' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            message: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.message }],
      },
      timeoutMs: config.timeoutMs,
      async execute(args, exec) {
        const session = await manager.requireSession(exec.agent)
        await session.type(args.selector, args.text)
        return { ok: true, message: `typed into "${args.selector}"` }
      },
    }),
    defineTool({
      name: 'browser_screenshot',
      description: 'Capture the current page viewport as a PNG and save it. Returns the absolute path of the saved image.',
      parameters: {
        path: { type: 'string', description: 'Optional file path for the PNG; defaults to browser-<timestamp>.png under the screenshot dir' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: `Screenshot saved to: ${value}` }],
      },
      timeoutMs: config.timeoutMs,
      async execute(args, exec) {
        const session = await manager.requireSession(exec.agent)
        const path = screenshotPath(config, args.path)
        await session.screenshot(path)
        return path
      },
    }),
    defineTool({
      name: 'browser_close',
      description: 'Close the current browser session and release its resources. A later browser tool starts a fresh session.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            message: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.message }],
      },
      timeoutMs: config.timeoutMs,
      async execute(_args, exec) {
        const closed = await manager.closeSession(exec.agent)
        return {
          ok: true,
          message: closed ? 'browser session closed' : 'no active browser session to close',
        }
      },
    }),
  ]
}
