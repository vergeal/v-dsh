/**
 * Playwright browser runtime for the webwright tools.
 *
 * One dedicated browser per host process, launched lazily on the first tool call. The browser keeps its own
 * persistent profile so it never touches the user's normal session, cookies, or extensions. Page state and tab ids
 * live in this module; they are not restored from a Session log.
 * @module dsh-webwright/browser
 */

import { existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Element-ref prefix stamped onto DOM nodes by a snapshot. */
const REF_ATTRIBUTE = 'data-webwright'

/** Candidate launch channels, in order: the user's Chrome, Edge, then Playwright's bundled Chromium. */
const CHANNELS = ['chrome', 'msedge', undefined]

/**
 * Resolve Playwright. The package is imported lazily so a missing install fails the first browser call with an
 * actionable message instead of preventing the plugin from loading.
 * @returns The `chromium` launcher.
 */
function loadPlaywright() {
  const require = createRequire(import.meta.url)
  const candidates = [
    process.env.WEBWRIGHT_PLAYWRIGHT,
    'playwright-core',
    'playwright',
  ].filter((value) => typeof value === 'string' && value.length > 0)
  const failures = []
  for (const candidate of candidates) {
    try {
      return require(candidate)
    } catch (error) {
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(
    'Playwright is unavailable. Install it beside this plugin (`npm install playwright-core`) or set '
      + `WEBWRIGHT_PLAYWRIGHT to a resolvable package. Tried: ${failures.join(' | ')}`,
  )
}

/**
 * Expand a configured profile path.
 * @param configured - Configured path, `~`-relative, or empty for the default.
 * @returns The absolute profile directory.
 */
function profilePath(configured) {
  if (typeof configured === 'string' && configured.length > 0) {
    return configured.startsWith('~') ? join(homedir(), configured.slice(1)) : configured
  }
  const home = process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), '.dsh')
  return join(home, 'webwright', 'profile')
}

/** Human-readable failure wrapper so every tool reports which operation failed. */
function untrusted(action, error) {
  const message = error instanceof Error ? error.message : String(error)
  return new Error(`${action} failed: ${message}`)
}

/**
 * Create the browser runtime.
 * @param options - `channel`, `profile`, `headless`, and `launchTimeoutMs` overrides.
 * @returns Runtime operations plus `dispose`.
 */
export function create(options = {}) {
  /** @type {{ profile: string, context?: import('playwright-core').BrowserContext, channel: string, tabs: Map<import('playwright-core').Page, number>, next: number, logs: WeakMap<import('playwright-core').Page, Array<{level: string, text: string}>>, launching?: Promise<{context: import('playwright-core').BrowserContext, channel: string}>, error?: string }} */
  const state = {
    profile: profilePath(options.profile),
    channel: '',
    tabs: new Map(),
    next: 1,
    logs: new WeakMap(),
  }

  async function start() {
    const { chromium } = loadPlaywright()
    const configured = typeof options.channel === 'string' && options.channel.length > 0 ? [options.channel] : undefined
    const attempts = configured ?? [...CHANNELS]
    const failures = []
    const timeout = typeof options.launchTimeoutMs === 'number' && options.launchTimeoutMs > 0 ? options.launchTimeoutMs : 30_000
    for (const channel of attempts) {
      try {
        const context = await chromium.launchPersistentContext(state.profile, {
          ...(channel === undefined ? {} : { channel }),
          headless: options.headless === true,
          viewport: null,
          timeout,
          args: ['--no-first-run', '--no-default-browser-check'],
        })
        state.context = context
        state.channel = channel ?? 'chromium'
        context.on('page', (page) => attach(page))
        context.pages().forEach((page) => attach(page))
        context.on('close', () => {
          state.context = undefined
          state.tabs.clear()
        })
        return { context, channel: state.channel }
      } catch (error) {
        failures.push(`${channel ?? 'chromium'}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    throw new Error(
      'No browser could start for the Webwright plugin. Tried '
        + `${attempts.map((item) => item ?? 'chromium').join(', ')}. Install Chrome or Edge, or run `
        + `\`npx playwright install chromium\` for the bundled build. ${failures.join(' | ')}`,
    )
  }

  function attach(page) {
    if (state.tabs.has(page)) return
    state.tabs.set(page, state.next++)
    // Record surfaces before the page's own scripts run, and re-run now for a page that was already loading.
    void page.addInitScript(surfaceRecorder).catch(() => {})
    void page.evaluate(surfaceRecorder).catch(() => {})
    const logs = []
    state.logs.set(page, logs)
    page.on('console', (message) => {
      const level = message.type() === 'debug' ? 'debug'
        : message.type() === 'info' ? 'info'
          : message.type() === 'warning' ? 'warning'
            : message.type() === 'error' ? 'error' : 'log'
      logs.push({ level, text: message.text().slice(0, 4_000) })
      if (logs.length > 200) logs.shift()
    })
    page.on('close', () => state.tabs.delete(page))
  }

  async function launch() {
    if (state.context) return { context: state.context, channel: state.channel }
    if (state.launching) return state.launching
    state.launching = start().finally(() => {
      state.launching = undefined
    })
    return state.launching
  }

  function tabID(page) {
    const id = state.tabs.get(page)
    if (id !== undefined) return id
    attach(page)
    return state.tabs.get(page)
  }

  async function page(id) {
    const { context } = await launch()
    for (const item of context.pages()) {
      attach(item)
      if (state.tabs.get(item) === id) return item
    }
    throw new Error(
      `No browser tab has id ${id}. Discard it and read webwright_tabs_list; tab ids can change after a close.`,
    )
  }

  async function tab(page) {
    return {
      id: tabID(page),
      url: page.url(),
      title: await page.title().catch(() => ''),
      active: await page.evaluate(() => document.visibilityState === 'visible').catch(() => false),
    }
  }

  async function withPage(id, action, run) {
    try {
      return await run(await page(id))
    } catch (error) {
      throw untrusted(action, error)
    }
  }

  async function locator(id, ref) {
    const item = await page(id)
    const found = item.locator(`[${REF_ATTRIBUTE}="${ref}"]`)
    if ((await found.count()) === 0) {
      throw new Error(
        `Element ref ${ref} is not on the page. Refs expire on navigation and on the next snapshot; `
          + 'call webwright_snapshot again and use a current ref.',
      )
    }
    return { item, found }
  }

  async function status() {
    try {
      const { context, channel } = await launch()
      state.error = undefined
      return {
        ready: true,
        browser: channel,
        version: context.browser()?.version() ?? '',
        profile: state.profile,
        tabs: context.pages().length,
      }
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error)
      return { ready: false, browser: '', version: '', profile: state.profile, tabs: 0, error: state.error }
    }
  }

  return {
    status,

    async tabs() {
      const { context } = await launch()
      return { tabs: await Promise.all(context.pages().map((item) => tab(item))) }
    },

    async open(input = {}) {
      try {
        const { context } = await launch()
        const item = await context.newPage()
        attach(item)
        await item.goto(input.url ?? 'about:blank', { waitUntil: 'domcontentloaded', timeout: 30_000 })
        if (input.active !== false) await item.bringToFront()
        return tab(item)
      } catch (error) {
        throw untrusted('webwright_tabs_open', error)
      }
    },

    async close(id) {
      return withPage(id, 'webwright_tabs_close', async (item) => {
        await item.close()
        state.tabs.delete(item)
        return { ok: true }
      })
    },

    async focus(id) {
      return withPage(id, 'webwright_tabs_focus', async (item) => {
        await item.bringToFront()
        return tab(item)
      })
    },

    async navigate(id, url) {
      return withPage(id, 'webwright_navigate', async (item) => {
        await item.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
        return tab(item)
      })
    },

    async back(id) {
      return withPage(id, 'webwright_back', async (item) => {
        await item.goBack({ waitUntil: 'domcontentloaded', timeout: 30_000 })
        return tab(item)
      })
    },

    async forward(id) {
      return withPage(id, 'webwright_forward', async (item) => {
        await item.goForward({ waitUntil: 'domcontentloaded', timeout: 30_000 })
        return tab(item)
      })
    },

    async reload(id) {
      return withPage(id, 'webwright_reload', async (item) => {
        await item.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 })
        return tab(item)
      })
    },

    async snapshot(id, maxNodes = 2_000, includeHidden = false) {
      return withPage(id, 'webwright_snapshot', async (item) => read(item, { maxNodes, includeHidden }))
    },

    async find(id, text) {
      return withPage(id, 'webwright_find', async (item) => {
        const result = await read(item, { maxNodes: 10_000, includeHidden: false })
        const needle = text.toLowerCase()
        const lines = result.content.split('\n').filter((line) => line.toLowerCase().includes(needle))
        const refs = lines.flatMap((line) => line.match(/\[e([1-9][0-9]*)\]/u)?.[1] ?? []).length
        return {
          content: lines.length > 0 ? lines.join('\n') : `No line contains ${JSON.stringify(text)}.`,
          truncated: result.truncated,
          refs,
          url: result.url,
          title: result.title,
        }
      })
    },

    async surfaces(id) {
      return withPage(id, 'webwright_surfaces', async (item) => {
        // A page that loaded before this plugin attached still needs the recorder; the store makes it idempotent.
        await item.evaluate(surfaceRecorder).catch(() => {})
        return readSurfaces(item)
      })
    },

    async clickAt(id, x, y, input = {}) {
      return withPage(id, 'webwright_click_at', async (item) => {
        const modifiers = [...(input.modifiers ?? [])]
        for (const key of modifiers) await item.keyboard.down(key)
        try {
          await item.mouse.click(x, y, { button: input.button ?? 'left', clickCount: input.count ?? 1 })
        } finally {
          for (const key of modifiers) await item.keyboard.up(key).catch(() => {})
        }
        return { ok: true }
      })
    },

    async drag(id, input) {
      return withPage(id, 'webwright_drag', async (item) => {
        const button = input.button ?? 'left'
        await item.mouse.move(input.fromX, input.fromY)
        await item.mouse.down({ button })
        try {
          await item.mouse.move(input.toX, input.toY, { steps: input.steps ?? 12 })
        } finally {
          await item.mouse.up({ button })
        }
        return { ok: true }
      })
    },

    async click(id, ref, input = {}) {
      const { found } = await locator(id, ref)
      try {
        await found.click({
          button: input.button ?? 'left',
          clickCount: input.count ?? 1,
          modifiers: [...(input.modifiers ?? [])],
        })
        return { ok: true }
      } catch (error) {
        throw untrusted('webwright_click', error)
      }
    },

    async hover(id, ref) {
      const { found } = await locator(id, ref)
      try {
        await found.hover()
        return { ok: true }
      } catch (error) {
        throw untrusted('webwright_hover', error)
      }
    },

    async fill(id, ref, text) {
      const { found } = await locator(id, ref)
      try {
        await found.fill(text)
        return { ok: true, value: await found.inputValue().catch(() => text) }
      } catch (error) {
        throw untrusted('webwright_fill', error)
      }
    },

    async fillForm(id, fields) {
      for (const field of fields) {
        const { found } = await locator(id, field.ref)
        try {
          if (field.type === 'text') await found.fill(field.value)
          else if (field.type === 'select') await found.selectOption([...field.values])
          else await found.setChecked(field.checked)
        } catch (error) {
          throw untrusted(`webwright_fill_form at ${field.ref}`, error)
        }
      }
      return { ok: true }
    },

    async select(id, ref, values) {
      const { found } = await locator(id, ref)
      try {
        return { ok: true, values: await found.selectOption([...values]) }
      } catch (error) {
        throw untrusted('webwright_select', error)
      }
    },

    async check(id, ref, checked) {
      const { found } = await locator(id, ref)
      try {
        await found.setChecked(checked)
        return { ok: true }
      } catch (error) {
        throw untrusted('webwright_check', error)
      }
    },

    async press(id, key, ref) {
      try {
        if (ref) {
          const { found } = await locator(id, ref)
          await found.press(key)
        } else {
          await (await page(id)).keyboard.press(key)
        }
        return { ok: true }
      } catch (error) {
        throw untrusted('webwright_press', error)
      }
    },

    async scroll(id, deltaY, ref) {
      return withPage(id, 'webwright_scroll', async (item) => {
        if (ref) await item.locator(`[${REF_ATTRIBUTE}="${ref}"]`).scrollIntoViewIfNeeded()
        await item.mouse.wheel(0, deltaY)
        return { ok: true, scrollY: await item.evaluate(() => window.scrollY) }
      })
    },

    async evaluate(id, script, ref) {
      return withPage(id, 'webwright_evaluate', async (item) => {
        const value = await item.evaluate(
          ({ script: source, ref: targetRef, attribute }) => {
            const target = targetRef ? document.querySelector(`[${attribute}="${targetRef}"]`) : document
            if (!target) throw new Error(`Element ref ${targetRef} is not on the page.`)
            // CSP can block Function construction; the error is reported instead of being hidden.
            return new Function('element', `return (${source})`)(target)
          },
          { script, ref, attribute: REF_ATTRIBUTE },
        )
        return { value: value ?? null }
      })
    },

    async html(id, selector) {
      return withPage(id, 'webwright_html', async (item) => {
        const html = selector
          ? await item.locator(selector).first().evaluate((element) => element.outerHTML)
          : await item.content()
        const limit = 100_000
        return {
          html: html.slice(0, limit),
          truncated: html.length > limit,
          url: item.url(),
          title: await item.title().catch(() => ''),
        }
      })
    },

    async screenshot(id, fullPage = false) {
      return withPage(id, 'webwright_screenshot', async (item) => {
        const bytes = await item.screenshot({ fullPage, type: 'png' })
        return { base64: Buffer.from(bytes).toString('base64'), mimeType: 'image/png' }
      })
    },

    async wait(id, input) {
      return withPage(id, 'webwright_wait', async (item) => {
        const timeout = input.timeoutMs ?? 30_000
        if (input.selector) await item.waitForSelector(input.selector, { timeout })
        else if (input.text) {
          await item.waitForFunction(
            (needle) => (document.body?.innerText ?? '').toLowerCase().includes(needle),
            input.text.toLowerCase(),
            { timeout },
          )
        } else throw new Error('webwright_wait needs text or selector.')
        return { ok: true }
      })
    },

    async console(id) {
      return withPage(id, 'webwright_console', async (item) => ({ messages: state.logs.get(item) ?? [] }))
    },

    async dispose() {
      const context = state.context
      state.context = undefined
      state.tabs.clear()
      if (context) await context.close().catch(() => {})
    },
  }
}

/**
 * Runs in every document before the page's own scripts. Canvas UIs draw after layout, and a repaint can replace the
 * DOM around the canvas, so the only reliable moment to record where a surface sits — and where it sat when it was
 * created — is the frame it first appears. The recorder keeps that first-seen box alongside the live one.
 */
function surfaceRecorder() {
  const store = (window.__webwright ??= { surfaces: [] })
  const box = (element) => {
    const rect = element.getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  }
  const keyOf = (element) => {
    const parts = []
    let current = element
    while (current && current !== document.documentElement) {
      const parent = current.parentElement
      const index = parent ? Array.from(parent.children).indexOf(current) + 1 : 1
      parts.unshift(`${current.tagName.toLowerCase()}:nth-child(${index})`)
      current = parent
    }
    return parts.join('>')
  }
  const record = (element) => {
    const seen = box(element)
    const existing = store.surfaces.find((entry) => entry.element === element)
    if (existing) {
      existing.seen = seen
      existing.updates += 1
      return
    }
    store.surfaces.push({ key: keyOf(element), tag: element.tagName.toLowerCase(), element, born: seen, seen, updates: 0 })
  }
  const scan = () =>
    document
      .querySelectorAll('canvas,svg,video,iframe,object,embed,[data-webwright-surface]')
      .forEach(record)
  if (store.installed) {
    scan()
    return
  }
  store.installed = true
  let scheduled = false
  const schedule = () => {
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(() => {
      scheduled = false
      scan()
    })
  }
  const start = () => {
    scan()
    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true })
  }
  if (document.documentElement) start()
  else document.addEventListener('DOMContentLoaded', start, { once: true })
  addEventListener('scroll', scan, { passive: true })
  addEventListener('resize', scan)
}

/**
 * Read the recorded surfaces, refreshing the live box and canvas backing-store scale.
 * @param item - The page to read.
 * @returns Viewport, title, and recorded surfaces.
 */
function readSurfaces(item) {
  return item.evaluate(() => {
    const store = window.__webwright
    const surfaces = (store?.surfaces ?? []).map((entry) => {
      const rect = entry.element.getBoundingClientRect()
      const connected = entry.element.isConnected
      const canvas = entry.element instanceof HTMLCanvasElement ? entry.element : undefined
      const centerX = rect.x + rect.width / 2
      const centerY = rect.y + rect.height / 2
      const inside = centerX >= 0 && centerY >= 0 && centerX <= window.innerWidth && centerY <= window.innerHeight
      // A surface that is not the topmost element at its own center is painted over, so a click there reaches
      // something else; report it instead of letting the agent guess.
      const covered = inside && document.elementFromPoint(centerX, centerY) !== entry.element
      return {
        tag: entry.tag,
        key: entry.key,
        name: (
          entry.element.getAttribute('aria-label')
          ?? entry.element.getAttribute('title')
          ?? entry.element.getAttribute('class')
          ?? ''
        ).slice(0, 120),
        box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        born: entry.born,
        ...(canvas
          ? {
              backing: { width: canvas.width, height: canvas.height },
              scale: { x: canvas.width / (rect.width || 1), y: canvas.height / (rect.height || 1) },
            }
          : {}),
        inViewport: inside,
        updates: entry.updates,
        connected,
        covered,
      }
    })
    return {
      url: location.href,
      title: document.title,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      devicePixelRatio: window.devicePixelRatio,
      surfaces,
    }
  })
}

/**
 * Read the page as a compact tree and stamp fresh refs, so actions can target stable data attributes.
 * @param item - The page to read.
 * @param input - Node cap and hidden-element policy.
 * @returns Tree text plus the tab's current URL and title.
 */
function read(item, input) {
  return item.evaluate(({ maxNodes, includeHidden, attribute }) => {
    document.querySelectorAll(`[${attribute}]`).forEach((element) => element.removeAttribute(attribute))
    const clean = (value) => (value ?? '').replace(/\s+/g, ' ').trim().slice(0, 160)
    const visible = (element) => {
      if (includeHidden) return true
      const style = getComputedStyle(element)
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
      const rect = element.getBoundingClientRect()
      return rect.width > 0 || rect.height > 0
    }
    const interactive =
      'a,button,input,select,textarea,summary,[role],[contenteditable],label,[onclick],[tabindex]'
    const nodes = Array.from(
      document.querySelectorAll(`${interactive},h1,h2,h3,h4,h5,h6,p,li,td,th,pre,code`),
    )
    const lines = []
    let refs = 0
    let truncated = false
    for (const element of nodes) {
      if (refs >= maxNodes) {
        truncated = true
        break
      }
      if (!visible(element)) continue
      const text = clean(element.textContent)
      if (element.matches(interactive)) {
        refs += 1
        const ref = `e${refs}`
        element.setAttribute(attribute, ref)
        const role = element.getAttribute('role') ?? element.tagName.toLowerCase()
        const name =
          clean(
            element.getAttribute('aria-label')
              ?? element.getAttribute('alt')
              ?? element.getAttribute('title')
              ?? (element instanceof HTMLInputElement ? element.value || element.placeholder : ''),
          ) || text.slice(0, 80)
        const extra = element instanceof HTMLInputElement
          ? ` type=${element.type}${element.type === 'checkbox' || element.type === 'radio' ? ` checked=${element.checked}` : ''}`
          : element instanceof HTMLSelectElement
            ? ` options=${element.options.length}`
            : ''
        lines.push(`[${ref}] ${role} "${name}"${extra}`)
      } else if (text) lines.push(`${element.tagName.toLowerCase()}: ${text.slice(0, 200)}`)
    }
    // Painted surfaces have no DOM inside them. Name them here so a caller knows to read coordinates from
    // webwright_surfaces instead of looking for element refs that cannot exist.
    for (const element of document.querySelectorAll('canvas,svg,video,iframe,object,embed')) {
      if (!visible(element)) continue
      const rect = element.getBoundingClientRect()
      lines.push(
        `surface ${element.tagName.toLowerCase()} ${Math.round(rect.width)}x${Math.round(rect.height)} at `
          + `${Math.round(rect.x)},${Math.round(rect.y)} — no DOM inside, use webwright_surfaces and webwright_click_at`,
      )
    }
    return {
      content: lines.join('\n'),
      truncated,
      refs,
      url: location.href,
      title: document.title,
    }
  }, { ...input, attribute: REF_ATTRIBUTE })
}
