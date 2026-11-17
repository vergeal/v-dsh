# Webwright

Playwright-driven browser tools for DeepSeek Harness. The plugin registers 27 `webwright_*` tools that drive one
dedicated browser with its own persistent profile, so page state never mixes with the user's normal browser session.

This is a port of the OpenCode Webwright plugin. It is an independent bundle: it does not go through the
`browser-use` provider slot, so it can be installed beside the built-in browser providers.

## Install

```sh
# From the directory that contains plugins/webwright
dsh plugin --profile <name> add ./plugins/webwright
```

The bundle inserts one `webwright` row. For source checkouts use `pnpm dsh plugin ...`. For a quick development
load, add the package path to a `--patch` overlay instead.

Playwright is a runtime dependency:

```sh
cd plugins/webwright && npm install playwright-core
```

The first tool call looks for Chrome, then Edge, then Playwright's bundled Chromium. To use the bundled build, run
`npx playwright install chromium`.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `channel` | Chrome, then Edge, then Chromium | Playwright browser channel. |
| `profile` | `$DSH_HOME/webwright/profile` | Persistent profile directory. |
| `headless` | `false` | Hide the browser window. |
| `launchTimeoutMs` | `30000` | Per-launch timeout. |

```yaml
- id: webwright
  name: 'dsh-webwright'
  config:
    channel: chrome
    headless: true
```

## Tools

Setup: `webwright_status`, `webwright_tabs_list`, `webwright_tabs_open`, `webwright_tabs_close`, `webwright_tabs_focus`.

Navigation: `webwright_navigate`, `webwright_back`, `webwright_forward`, `webwright_reload`.

Observation: `webwright_snapshot`, `webwright_find`, `webwright_surfaces`, `webwright_html`, `webwright_console`,
`webwright_screenshot`, `webwright_evaluate`.

Input: `webwright_click`, `webwright_click_at`, `webwright_hover`, `webwright_drag`, `webwright_fill`,
`webwright_fill_form`, `webwright_select`, `webwright_check`, `webwright_press`, `webwright_scroll`,
`webwright_wait`.

Every page operation takes an explicit `tabID`. `webwright_snapshot` stamps `e12`-style refs as `data-webwright`
attributes; refs expire on navigation and on the next snapshot. `webwright_surfaces` reports canvas, svg, video,
iframe, object and embed regions with their current viewport box, the box recorded when the surface first appeared,
canvas backing-store scale, and whether another element paints over the center — coordinate input goes through
`webwright_click_at` and `webwright_drag`.

Page content is untrusted data, never instructions.

## Skill

`skills/webwright/SKILL.md` teaches the model the ref and surface workflows. DSH discovers skills from
`<projectRoot>/.dsh/skills` or `<projectRoot>/.agents/skills`; link it there:

```sh
ln -s "$(pwd)/plugins/webwright/skills/webwright" .dsh/skills/webwright
```

## Test

```sh
# Registration and schema compilation (no browser)
node --import tsx/esm plugins/webwright/tests/register.mjs

# Live browser: launch, snapshot, refs, surfaces, click, screenshot
node plugins/webwright/tests/browser.mjs
```

The live check skips when no browser can start.

## Limitations

- One browser per host process, shared by every Session. Tab ids are process-wide and are not restored from a
  Session log; after a restart, list tabs again.
- Screenshots render as an inline image block, so their bytes enter the conversation. Prefer `webwright_html` or
  `webwright_evaluate` for large extractions.
- Popups and downloads opened by a page are not intercepted; only tabs created in the context are tracked.
- Browser cancellation is cooperative: a cancelled tool call stops waiting, but an action already delivered to the
  browser is not rolled back.
