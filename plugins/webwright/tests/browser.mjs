/**
 * Live browser check: launch headless, read a DOM snapshot and its surfaces, act on a ref, then close.
 * Run with: node plugins/webwright/tests/browser.mjs
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { create } from '../browser.js'

const profile = await mkdtemp(join(tmpdir(), 'webwright-smoke-'))
const runtime = create({ headless: true, profile, launchTimeoutMs: 45_000 })
try {
  const status = await runtime.status()
  console.log('status:', status)
  if (!status.ready) {
    console.log('SKIP: no browser could start')
    process.exit(0)
  }
  const page = 'data:text/html,' + encodeURIComponent(
    '<h1>Webwright smoke</h1><button id=b>Press me</button>'
    + '<canvas width=80 height=40 style="width:40px;height:20px"></canvas>'
    + '<script>document.querySelector("#b").onclick=()=>{document.title="clicked"}</script>',
  )
  const tab = await runtime.open({ url: page })
  console.log('tab:', tab)

  const snapshot = await runtime.snapshot(tab.id)
  console.log('snapshot:', JSON.stringify(snapshot.content))
  if (!/\[e[1-9][0-9]*\]/.test(snapshot.content)) throw new Error('snapshot stamped no refs')

  const surfaces = await runtime.surfaces(tab.id)
  console.log('surfaces:', surfaces.surfaces.map((item) => item.tag + ' ' + item.box.width + 'x' + item.box.height))

  const ref = snapshot.content.match(/\[(e[1-9][0-9]*)\] button/u)?.[1]
  if (!ref) throw new Error('no button ref found')
  await runtime.click(tab.id, ref)
  const after = await runtime.snapshot(tab.id)
  console.log('after click title:', JSON.stringify(after.title))

  const shot = await runtime.screenshot(tab.id)
  console.log('screenshot bytes:', Math.round(shot.base64.length * 0.75))
  console.log('OK')
} finally {
  await runtime.dispose()
  await rm(profile, { recursive: true, force: true })
}
