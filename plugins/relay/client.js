/**
 * Browser half of Relay: the paper-plane delivery effect.
 *
 * A watcher in the current Session reads successful `session_send` tool
 * results, an overlay flies a paper plane with a light trail to the target
 * Session row, and the row shows a received badge. Everything here is
 * presentation; delivery and history stay in the Host half.
 */
window.__ModuleLoader__.load({
  id: 'dsh-relay',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Duration of one flight, in milliseconds. */
    const FLIGHT_MS = 1500
    /** Trailing light dots outlive the flight by this budget. */
    const DOT_LIFE_MS = 620
    /** Interval between two trail dots. */
    const DOT_INTERVAL_MS = 38

    /** Message channel between the watcher, the overlay, and row badges. */
    const listeners = new Set()
    function publish(event) {
      for (const listener of listeners) listener(event)
    }
    function listen(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }

    /** Row geometry providers keyed by Session id; the overlay reads them at launch. */
    const rowRects = new Map()
    function rowRect(sessionId) {
      const read = rowRects.get(sessionId)
      return read === undefined ? null : read()
    }

    /** Paper-plane glyph used for flight and the received badge. */
    const PLANE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true">'
      + '<path d="M2.2 11.3 21.6 3.1 14.2 20.9l-3.1-6.2L2.2 11.3Z" fill="#679EFE"/>'
      + '<path d="M11.1 14.7 17.9 6.6" stroke="#fff" stroke-width="1.3" stroke-linecap="round" opacity=".9"/>'
      + '</svg>'

    /** Scoped stylesheet; removed with the plugin fiber. */
    const CSS = `
      .dsh-relay-layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483000; overflow: hidden; }
      .dsh-relay-plane { position: absolute; left: 0; top: 0; width: 24px; height: 24px; margin: -12px 0 0 -12px; will-change: transform; filter: drop-shadow(0 0 7px rgba(103,158,254,.85)); }
      .dsh-relay-plane svg { display: block; width: 100%; height: 100%; }
      .dsh-relay-dot { position: absolute; left: 0; top: 0; width: 7px; height: 7px; margin: -3.5px 0 0 -3.5px; border-radius: 50%; background: radial-gradient(circle, rgba(178,212,255,.95) 0%, rgba(103,158,254,.45) 45%, rgba(103,158,254,0) 72%); will-change: transform, opacity; }
      .dsh-relay-pulse { position: absolute; left: 0; top: 0; width: 56px; height: 56px; margin: -28px 0 0 -28px; border-radius: 50%; border: 2px solid rgba(103,158,254,.8); animation: dsh-relay-pulse 900ms ease-out forwards; }
      @keyframes dsh-relay-pulse { 0% { transform: scale(.35); opacity: .95 } 100% { transform: scale(1.9); opacity: 0 } }
      .dsh-relay-row { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; }
      .dsh-relay-badge { display: block; width: 12px; height: 12px; animation: dsh-relay-badge 1600ms ease-out forwards; }
      .dsh-relay-badge svg { display: block; width: 100%; height: 100%; filter: drop-shadow(0 0 4px rgba(103,158,254,.8)); }
      @keyframes dsh-relay-badge { 0% { transform: scale(.2); opacity: 0 } 18% { transform: scale(1.25); opacity: 1 } 65% { transform: scale(1); opacity: 1 } 100% { transform: scale(1); opacity: 0 } }
      @media (prefers-reduced-motion: reduce) {
        .dsh-relay-plane { display: none; }
        .dsh-relay-dot { display: none; }
        .dsh-relay-pulse { animation-duration: 350ms; }
        .dsh-relay-badge { animation-duration: 600ms; }
      }
    `

    /** Point on the quadratic curve at `t`. */
    function curvePoint(start, control, end, t) {
      const inv = 1 - t
      return {
        x: inv * inv * start.x + 2 * inv * t * control.x + t * t * end.x,
        y: inv * inv * start.y + 2 * inv * t * control.y + t * t * end.y,
      }
    }

    /** Watch the current Session's tool results and publish deliveries. */
    function makeWatcher(ctx) {
      return function RelayWatcher({ sessionId }) {
        const originRef = React.useRef(null)
        React.useEffect(() => {
          if (sessionId === undefined) return undefined
          const session = ctx.sessions.get(sessionId)
          const seen = new Set()
          let primed = false
          let disposed = false
          const scan = () => {
            if (disposed) return
            const window = session.eventSource.getSnapshot()
            for (const entry of window.entries) {
              if (entry.type !== 'event') continue
              const event = entry.event
              if (seen.has(event.seq)) continue
              seen.add(event.seq)
              const meta = event.type === 'tool/result' ? event.data?.meta : undefined
              if (meta === undefined || meta === null || meta.relay !== 'send') continue
              if (!primed) continue
              publish({
                kind: 'send',
                fromSessionId: sessionId,
                toSessionId: meta.target_session_id,
                messageId: meta.message_id,
                origin: originRef.current?.getBoundingClientRect() ?? null,
              })
            }
            primed = true
          }
          const stop = session.eventSource.subscribe(scan)
          scan()
          return () => {
            disposed = true
            stop()
          }
        }, [sessionId])
        return h('span', {
          ref: originRef,
          'data-relay-origin': '',
          style: { position: 'absolute', width: '1px', height: '1px', opacity: 0, pointerEvents: 'none' },
        })
      }
    }

    /** Flight layer: one paper plane, its light trail, and the landing pulse. */
    function RelayOverlay() {
      const layerRef = React.useRef(null)
      React.useEffect(() => {
        const layer = layerRef.current
        if (layer === null) return undefined
        let disposed = false
        const stop = listen((event) => {
          if (event.kind !== 'send') return
          void fly(event, layer, () => disposed)
        })
        return () => {
          disposed = true
          stop()
          layer.replaceChildren()
        }
      }, [])
      return h('div', { ref: layerRef, className: 'dsh-relay-layer', 'aria-hidden': 'true' })
    }

    /** Fly one plane from the composer to the target row, then pulse and notify it. */
    async function fly(event, layer, isDisposed) {
      const originRect = event.origin
      const start = originRect === null
        ? { x: window.innerWidth / 2, y: window.innerHeight * 0.78 }
        : { x: originRect.left + originRect.width / 2, y: originRect.top + originRect.height / 2 - 60 }
      const targetRect = rowRect(event.toSessionId)
      const end = targetRect === null
        ? { x: 120, y: 260 }
        : { x: targetRect.left + targetRect.width / 2, y: targetRect.top + targetRect.height / 2 }
      const control = { x: (start.x + end.x) / 2, y: Math.min(start.y, end.y) - 150 }
      const plane = document.createElement('div')
      plane.className = 'dsh-relay-plane'
      plane.innerHTML = PLANE_SVG
      layer.append(plane)
      const dots = []
      const startedAt = performance.now()
      let lastDotAt = 0
      await new Promise((resolve) => {
        const frame = (now) => {
          if (isDisposed()) {
            resolve()
            return
          }
          const progress = Math.min(1, (now - startedAt) / FLIGHT_MS)
          const eased = progress * progress * (3 - 2 * progress)
          const point = curvePoint(start, control, end, eased)
          const ahead = curvePoint(start, control, end, Math.min(1, eased + 0.03))
          const angle = Math.atan2(ahead.y - point.y, ahead.x - point.x) * 180 / Math.PI
          plane.style.transform = `translate(${point.x}px, ${point.y}px) rotate(${angle}deg)`
          if (now - lastDotAt >= DOT_INTERVAL_MS) {
            lastDotAt = now
            const dot = document.createElement('span')
            dot.className = 'dsh-relay-dot'
            layer.append(dot)
            dots.push({ element: dot, bornAt: now, x: point.x, y: point.y })
          }
          for (const dot of dots) {
            if (dot.gone === true) continue
            const life = (now - dot.bornAt) / DOT_LIFE_MS
            if (life >= 1) {
              dot.gone = true
              dot.element.remove()
              continue
            }
            dot.element.style.transform = `translate(${dot.x}px, ${dot.y}px) scale(${1 - life * 0.72})`
            dot.element.style.opacity = String(0.85 * (1 - life))
          }
          if (progress < 1) requestAnimationFrame(frame)
          else resolve()
        }
        requestAnimationFrame(frame)
      })
      plane.remove()
      for (const dot of dots) if (dot.gone !== true) dot.element.remove()
      if (isDisposed()) return
      const pulse = document.createElement('div')
      pulse.className = 'dsh-relay-pulse'
      pulse.style.transform = `translate(${end.x}px, ${end.y}px)`
      layer.append(pulse)
      setTimeout(() => pulse.remove(), 950)
      publish({ kind: 'arrived', toSessionId: event.toSessionId })
    }

    /** Row badge that registers its row geometry and flashes when a plane lands. */
    function RelayRow({ sessionId }) {
      const ref = React.useRef(null)
      const [landed, setLanded] = React.useState(false)
      React.useEffect(() => {
        rowRects.set(sessionId, () => ref.current?.getBoundingClientRect() ?? null)
        return () => { rowRects.delete(sessionId) }
      }, [sessionId])
      React.useEffect(() => {
        let timer
        const stop = listen((event) => {
          if (event.kind !== 'arrived' || event.toSessionId !== sessionId) return
          setLanded(false)
          setLanded(true)
          clearTimeout(timer)
          timer = setTimeout(() => setLanded(false), 1650)
        })
        return () => {
          clearTimeout(timer)
          stop()
        }
      }, [sessionId])
      return h('span', { ref, className: 'dsh-relay-row', 'data-relay-session': sessionId },
        landed === true
          ? h('span', { className: 'dsh-relay-badge', dangerouslySetInnerHTML: { __html: PLANE_SVG } })
          : null)
    }

    return {
      /** Browser services the effect reads. */
      inject: ['slots', 'sessions'],
      /**
       * Register the stylesheet, the watcher, the flight layer, and row badges.
       * @param ctx - browser plugin context.
       */
      apply(ctx) {
        const style = document.createElement('style')
        style.dataset.relay = 'effects'
        style.textContent = CSS
        ctx.effect(() => {
          document.head.append(style)
          return () => { style.remove() }
        })

        const Watcher = makeWatcher(ctx)
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'relay.origin',
          order: 40,
        }, Watcher))
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'relay.flight',
        }, RelayOverlay))
        ctx.slots.inject('sidebar.session.row.trailing', () => ctx.slots.register({
          name: 'sidebar.session.row.trailing',
          id: 'relay.badge',
          order: 60,
        }, RelayRow))
      },
    }
  },
})
