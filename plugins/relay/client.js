/**
 * Browser half of Relay: the row-to-row delivery animation.
 *
 * A watcher on the current Session reads successful `session_queue_send`
 * and `session_steer_send` results,
 * then an envelope flies from the SENDING Session's sidebar row to the
 * RECEIVING Session's row — both rows are highlighted so each delivery shows
 * who sent to whom. Ported from the user's reference implementation
 * (`.dsh/ref/deliver-flight/`: envelope-flight.ts, overlay.ts, motion.ts);
 * see README for the port mapping and the undo-bin exclusion.
 */
window.__ModuleLoader__.load({
  id: 'dsh-relay',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    // ---------- reference: envelope-flight.ts constants ----------
    const WIDTH = 38
    const HEIGHT = 28
    const SVG_NS = 'http://www.w3.org/2000/svg'
    const FLIGHT_MS = 1500
    // Fraction of the clock the letter rests on the sender before it leaves, and the fraction at which it lands.
    const HOLD = 0.24
    const ARRIVE = 0.9
    const STEPS = 28
    const HIGHLIGHT_MS = 900

    // DSH theme variables stand in for the reference's --v2-* tokens; the fallback renders
    // correctly on a host whose theme defines none of the aliased names.
    const ACCENT = 'var(--dsw-alias-onboarding-accent, var(--dsw-alias-state-business-primary, #679EFE))'
    const PAPER = 'var(--dsw-alias-button-elevated-fill, rgba(255,255,255,.92))'
    const SHADOW =
      'drop-shadow(0 8px 18px color-mix(in oklch, var(--dsw-alias-onboarding-accent, #679EFE) 45%, transparent))'
      + ' drop-shadow(0 2px 6px rgb(0 0 0 / 0.22))'

    /**
     * Reduced-motion read, ported from the reference motion.ts with the
     * opencode-specific `<html data-motion>` override dropped. Matches the
     * `matchMedia` pattern the DSH client packages use inline
     * (ui-chat/flow-motion.ts, ui-primitives AnimatedRows).
     * @returns whether delivery animation must be skipped.
     */
    function prefersReducedMotion() {
      return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false
    }

    // ---------- reference: overlay.ts (mount + the one rAF driver) ----------
    /** Fixed, non-interactive layer over the page. Callers own position, size, and content. */
    function mountOverlay(element, zIndex) {
      Object.assign(element.style, { position: 'fixed', pointerEvents: 'none', zIndex: String(zIndex) })
      document.body.appendChild(element)
    }

    let frame = 0
    const followers = new Set()
    function pump() {
      for (const follow of followers) follow()
      frame = followers.size > 0 ? requestAnimationFrame(pump) : 0
    }

    /**
     * Register a per-frame update while a cue is alive; the shared rAF loop stops
     * with the last follower.
     * @param update - per-frame callback re-reading live geometry.
     * @returns the unregister function.
     */
    function followRow(update) {
      followers.add(update)
      if (frame === 0) frame = requestAnimationFrame(pump)
      return () => {
        followers.delete(update)
        if (followers.size === 0 && frame !== 0) {
          cancelAnimationFrame(frame)
          frame = 0
        }
      }
    }

    /**
     * The sidebar row for one Session. `data-row-key="session:<id>"` is the stable
     * attribute ui-workspace renders on every session row; it replaces the
     * reference's `replicaRow` selector.
     * @param sessionId - the Session whose row is needed.
     * @returns the row element, or null when the row is not on screen.
     */
    function rowElement(sessionId) {
      return document.querySelector(`[data-row-key="session:${CSS.escape(String(sessionId))}"]`)
    }

    // ---------- reference: easing + quadratic route ----------
    function easeInOut(u) {
      return u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2
    }

    function curve(x0, y0, cx, cy, x1, y1) {
      return (u) => {
        const t = easeInOut(u)
        const inv = 1 - t
        return {
          x: inv * inv * x0 + 2 * inv * t * cx + t * t * x1,
          y: inv * inv * y0 + 2 * inv * t * cy + t * t * y1,
        }
      }
    }

    /** Trace the accent route behind the letter so the direction reads at a glance. */
    function createTrail(d) {
      const svg = document.createElementNS(SVG_NS, 'svg')
      svg.setAttribute('width', String(window.innerWidth))
      svg.setAttribute('height', String(window.innerHeight))
      svg.dataset.sessionDeliveryTrail = ''
      svg.setAttribute('aria-hidden', 'true')
      Object.assign(svg.style, { left: '0', top: '0', overflow: 'visible' })
      const path = document.createElementNS(SVG_NS, 'path')
      path.setAttribute('d', d)
      path.setAttribute('fill', 'none')
      path.setAttribute('stroke', ACCENT)
      path.setAttribute('stroke-width', '1.5')
      path.setAttribute('stroke-linecap', 'round')
      path.style.opacity = '0.5'
      svg.appendChild(path)
      return { svg, path }
    }

    function createLetter() {
      const letter = document.createElement('div')
      letter.dataset.sessionDeliveryLetter = ''
      letter.setAttribute('aria-hidden', 'true')
      Object.assign(letter.style, {
        left: '0',
        top: '0',
        width: `${WIDTH}px`,
        height: `${HEIGHT}px`,
        willChange: 'transform',
      })
      const body = document.createElement('div')
      Object.assign(body.style, { width: '100%', height: '100%', willChange: 'transform, opacity', filter: SHADOW })
      body.innerHTML = `<svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 38 28" fill="none">`
        + `<rect x="1" y="1" width="36" height="26" rx="5" fill="${PAPER}" stroke="${ACCENT}" stroke-width="1.8"/>`
        + `<path d="M4 5.5 19 17 34 5.5" stroke="${ACCENT}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      letter.appendChild(body)
      return { letter, body }
    }

    /** Ring a row with an inset accent border that fades out. */
    function highlight(row, duration) {
      if (prefersReducedMotion() || row.animate === undefined) return
      row.animate(
        [
          { boxShadow: `inset 0 0 0 0px ${ACCENT}` },
          { boxShadow: `inset 0 0 0 2px ${ACCENT}`, offset: 0.3 },
          { boxShadow: `inset 0 0 0 0px ${ACCENT}` },
        ],
        { duration, easing: 'ease-out' },
      )
    }

    /**
     * Fly an envelope from the sender's sidebar row to the receiver's, arc it out of
     * the list, and land it with a highlight on both rows. A row that is not on screen
     * has nowhere to launch from or land on, so the flight is skipped, never guessed.
     * @param from - the sending Session id.
     * @param to - the receiving Session id.
     */
    function playDeliveryFlight(from, to) {
      if (typeof document === 'undefined' || prefersReducedMotion() || from === to) return

      const source = rowElement(from)
      const target = rowElement(to)
      if (source === null || target === null) return

      const fromRect = source.getBoundingClientRect()
      const toRect = target.getBoundingClientRect()
      if (fromRect.width === 0 || toRect.width === 0) return

      const startX = fromRect.left + fromRect.width / 2
      const startY = fromRect.top + fromRect.height / 2
      const endX = toRect.left + toRect.width / 2
      const endY = toRect.top + toRect.height / 2
      // Bow the route sideways so the letter arcs out of the list instead of sliding along the rows.
      const bend = Math.min(110, Math.max(40, Math.hypot(endX - startX, endY - startY) * 0.28))
      const controlX = (startX + endX) / 2 - bend
      const controlY = (startY + endY) / 2
      const route = curve(startX, startY, controlX, controlY, endX, endY)

      const { letter, body } = createLetter()
      letter.dataset.relayFrom = String(from)
      letter.dataset.relayTo = String(to)
      const { svg, path } = createTrail(`M ${startX} ${startY} Q ${controlX} ${controlY} ${endX} ${endY}`)
      mountOverlay(svg, 9998)
      mountOverlay(letter, 9999)

      // Both endpoints can shift while the letter is in the air — a row inserted between
      // them, the list settling. Shift the whole route by how far the pair's midpoint
      // moved, so the letter keeps flying between the rows themselves; the absolute
      // keyframe coordinates stay valid throughout.
      const midpoint = () => {
        const a = source.getBoundingClientRect()
        const b = target.getBoundingClientRect()
        return {
          x: (a.left + a.width / 2 + b.left + b.width / 2) / 2,
          y: (a.top + a.height / 2 + b.top + b.height / 2) / 2,
        }
      }
      const origin = midpoint()
      const stop = followRow(() => {
        const now = midpoint()
        const dx = now.x - origin.x
        const dy = now.y - origin.y
        svg.style.transform = `translate(${dx}px, ${dy}px)`
        letter.style.left = `${dx}px`
        letter.style.top = `${dy}px`
      })

      highlight(source, HIGHLIGHT_MS)

      const translate = (x, y) => `translate(${x - WIDTH / 2}px, ${y - HEIGHT / 2}px)`
      const at = (u) => {
        const point = route(u)
        return { transform: translate(point.x, point.y), offset: HOLD + u * (ARRIVE - HOLD) }
      }

      // Displacement, scale, and the traced line run in parallel on one shared offset;
      // only the landing rebound hangs on flight.finished.
      const flight = letter.animate(
        [
          { transform: translate(startX, startY), offset: 0 },
          { transform: translate(startX, startY), offset: HOLD },
          ...Array.from({ length: STEPS }, (_, index) => at((index + 1) / STEPS)),
          { transform: translate(endX, endY), offset: 1 },
        ],
        { duration: FLIGHT_MS, easing: 'linear' },
      )

      body.animate(
        [
          { transform: 'scale(.3)', opacity: 0 },
          { transform: 'scale(1)', opacity: 1, offset: 0.12 },
          { transform: 'scale(1.12)', opacity: 1, offset: HOLD },
          { transform: 'scale(1)', opacity: 1, offset: ARRIVE },
          { transform: 'scale(.55)', opacity: 0, offset: 1 },
        ],
        { duration: FLIGHT_MS, easing: 'cubic-bezier(.22, 1, .36, 1)' },
      )

      const length = path.getTotalLength()
      path.style.strokeDasharray = `${length}`
      path.animate(
        [
          { strokeDashoffset: `${length}`, opacity: 0.5, offset: 0 },
          { strokeDashoffset: `${length}`, opacity: 0.5, offset: HOLD },
          ...Array.from({ length: STEPS }, (_, index) => {
            const u = (index + 1) / STEPS
            return {
              strokeDashoffset: `${length * (1 - easeInOut(u))}`,
              opacity: 0.5,
              offset: HOLD + u * (ARRIVE - HOLD),
            }
          }),
          { strokeDashoffset: '0', opacity: 0, offset: 1 },
        ],
        { duration: FLIGHT_MS, easing: 'linear' },
      )

      const finish = () => {
        stop()
        letter.remove()
        svg.remove()
        highlight(target, HIGHLIGHT_MS)
        if (prefersReducedMotion() || target.animate === undefined) return
        target.animate(
          [
            { transform: 'scale(1)' },
            { transform: 'scale(1.035)', offset: 0.35 },
            { transform: 'scale(1)' },
          ],
          { duration: 520, easing: 'cubic-bezier(.34, 1.36, .64, 1)' },
        )
      }

      void flight.finished.then(finish, () => {
        stop()
        letter.remove()
        svg.remove()
      })
    }

    // ---------- Host delivery events ----------
    /**
     * Event types that carry one tool call's presentation metadata: a direct call
     * arrives as `tool/result`, a call nested inside `run_code` as `tool/ptc-dispatch`.
     */
    const RESULT_EVENT_TYPES = new Set(['tool/result', 'tool/ptc-dispatch'])

    /**
     * Delivery metadata of one successful queue or steer send, or undefined for any other event.
     * @param event - one event from the current Session window.
     * @returns the send metadata, or undefined.
     */
    function sendResultMeta(event) {
      if (!RESULT_EVENT_TYPES.has(event.type)) return undefined
      const data = event.data
      if (data === undefined || data.isError === true) return undefined
      const meta = data.meta
      return meta?.relay === 'send' ? meta : undefined
    }

    /** Watch the current Session's send results and fly the matching deliveries. */
    function makeWatcher(ctx) {
      return function RelayWatch({ sessionId }) {
        React.useEffect(() => {
          if (sessionId === undefined) return undefined
          const binding = ctx.sessions.binding(sessionId)
          if (binding === undefined) return undefined
          const seen = new Set()
          // Delivery baseline: the highest event seq of the FIRST NONEMPTY snapshot.
          // Loading older history or a reconnect repair page republishes PRE-EXISTING
          // send results as seqs this watcher has never seen; replaying them would fly
          // envelopes for deliveries that happened long ago. The baseline covers ALL
          // events, not only sends, so an early send event can never dodge it.
          let baseline = null
          let disposed = false
          const scan = () => {
            if (disposed) return
            const window = binding.eventSource.getSnapshot()
            const events = window.entries.filter(entry => entry.type === 'event').map(entry => entry.event)
            // An empty snapshot means the window is not hydrated yet: no trustworthy
            // baseline exists, so nothing may fly this round and priming stays open.
            // A genuinely blank Session stays here too — it has no sends to replay, and
            // its first real send arrives as a live event that flies after hydrate.
            if (baseline === null) {
              if (events.length === 0) return
              baseline = Math.max(...events.map(event => event.seq))
              for (const event of events) seen.add(event.seq)
              return
            }
            // Hard guard: without a baseline nothing ever flies, however the code is
            // refactored later.
            if (baseline === null) return
            for (const event of events) {
              if (event.seq <= baseline) continue
              baseline = event.seq
              const meta = sendResultMeta(event)
              if (meta === undefined) continue
              const from = typeof meta.from_session_id === 'string' ? meta.from_session_id : sessionId
              playDeliveryFlight(from, meta.target_session_id)
            }
          }
          // Baseline BEFORE subscribing: the subscription callback itself runs scan, so
          // subscribing first would risk a synchronous first callback racing ahead of it.
          scan()
          const stop = binding.eventSource.subscribe(scan)
          return () => {
            disposed = true
            stop()
          }
        }, [sessionId])
        return h('span', {
          'data-relay-origin': '',
          style: { position: 'absolute', width: '1px', height: '1px', opacity: 0, pointerEvents: 'none' },
        })
      }
    }

    return {
      /** Browser services the effect reads. */
      inject: ['slots', 'sessions'],
      /**
       * Register the send watcher; flight paints into body-mounted overlays.
       * @param ctx - browser plugin context.
       */
      apply(ctx) {
        const Watch = makeWatcher(ctx)
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'relay.watch',
          order: 40,
        }, Watch))
      },
    }
  },
})
