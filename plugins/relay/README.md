# Relay

Cross-session messaging for DeepSeek Harness. The model can discover, read, activate, message, create, fork, interrupt, rename, and archive Sessions; the Web GUI flies an envelope from the sending Session's sidebar row to the receiving one when a message is sent.

## Tools

Every tool has exactly one job. The model-facing descriptions state when not to use each one.

| Tool | One job | Requires |
|---|---|---|
| `session_list` | List Sessions the caller may address | — |
| `session_read` | Read one Session's conversation messages | `session_id` |
| `session_open` | Make a cold Session resident | `session_id` |
| `session_send` | Deliver one message to a resident Session | `session_id`, `content` |
| `session_wait` | Wait until a resident Session is idle | `session_id` |
| `session_create` | Create a blank Session | — |
| `session_fork` | Copy history from an existing Session | `session_id` |
| `session_interrupt` | Stop the target's current turn | `session_id` |
| `session_rename` | Change a title | `session_id`, `title` |
| `session_archive` | Add or remove from the archived set | `session_id`, `archived` |

Deliberately absent: a second search tool (use the session-query package), raw event reads, Session close, and a send-and-wait shortcut.

## Delivery semantics

- `session_send` accepts a message into the target Agent's inbox: `queue` starts the next turn, `steer` targets the nearest step of a running turn.
- Acceptance is not completion. Use `session_wait` or `session_read` for the result.
- A cold target is refused. Call `session_open` first, or `session_fork` to branch from it. The tool never wakes a cold Session implicitly.
- The caller Session cannot be its own target.
- A `request_id` makes retries idempotent: the first receipt is returned again.
- Messages are recorded as `user/message` with source `{ kind: 'agent-message', form: 'relay', senderSessionId }`, so the target can see who sent it and reply with the same tool.

## Authorization

By default, list/read/open/send/wait/fork/rename/archive address only Sessions whose `cwd` exactly matches the caller's. A caller that records no `cwd` can address only itself. Set `allowCrossWorkspace: true` to lift the working-directory check.

Subagent Sessions are hidden from `session_list` unless `include_subagents` is true.

## Delivery flight (ported)

The animation is a direct port of the user's reference implementation (`.dsh/ref/deliver-flight/`: `envelope-flight.ts`, `overlay.ts`, `motion.ts`), hand-translated to this plugin's dependency-free browser module. It answers one question visually: **which Session sent to which Session**.

On a successful `session_send`, an envelope flies along an arced trail **from the sending Session's sidebar row to the receiving Session's row** (1.5 s). The sender's row lights up at takeoff; the receiver's row lights up and rebounds at landing, so both rows are visible at the moment of arrival. A successful call reaches the page as a `tool/result` event, or as `tool/ptc-dispatch` when the model called it inside `run_code`; both carry `meta.relay = 'send'` and start the flight, and a failed call starts none.

The reference's geometry and timing are kept exactly: `FLIGHT_MS=1500`, `HOLD=0.24`, `ARRIVE=0.9`, 28 route steps; displacement, scale, and the traced line run in parallel on one shared offset; only the landing rebound hangs on `flight.finished`. The letter animation is `linear` because the route evaluates `easeInOut` internally; changing it would double-ease. While the letter is airborne the two row rects are re-read every frame and the whole route shifts by the midpoint delta (rows can be inserted or scroll), so the absolute keyframe coordinates stay valid; a single shared rAF loop drives all followers and stops with the last one.

Silent skips, never guessed coordinates: no DOM, `prefers-reduced-motion`, `from === to`, a missing row, or a zero-width row. The row lookup uses ui-workspace's stable `data-row-key="session:<id>"` attribute in place of the reference's `replicaRow` selector; the flight element carries `data-session-delivery-letter` with `data-relay-from`/`data-relay-to` added for verification.

Port deltas from the reference, deliberate and recorded:

- Colors map the reference's `--v2-*` tokens to DSH aliases with fallbacks (`--dsw-alias-onboarding-accent`, `--dsw-alias-state-business-primary`, `#679EFE`).
- `prefersReducedMotion` keeps the reference's `matchMedia` read and drops the opencode-specific `<html data-motion>` override. DSH has no shared motion utility to reuse: client packages read `matchMedia` inline (for example ui-chat `flow-motion.ts`).
- The undo-bin sequence (`playUndoDrop`, trash bin, lid, destroy) is **not ported**: DSH's `SessionEventMap` has no cross-session withdrawal event, `agent/inbox/spliced` carries same-Session queue-edit semantics instead, and Relay offers no retract operation. No fake event was invented to keep half of it.
- No 50 ms mount-polling fallback was introduced: the receiving row is listed in the sidebar long before the send event arrives (verified live), so a missing row means the silent-skip case, not a late-render case.
- The reference is TypeScript; this plugin stays plain browser JavaScript with no build step, so the translation is line-faithful rather than byte-level.

The flight needs the sending Session open in the same browser page; it does not synchronize across windows. The effect depends on nothing in the Host: disabling `client.js` leaves delivery unchanged.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `maxListSessions` | 30 | Sessions one list call describes |
| `maxReadMessages` | 50 | Messages one read page returns |
| `maxWaitMs` | 120000 | Upper bound for `session_wait` |
| `allowCrossWorkspace` | false | Address Sessions in another working directory |
| `allowArchive` | false | Permit `session_archive` |
| `allowSteer` | true | Permit `delivery: "steer"` |

## Enable

Add the package to the profile and select its bundle:

```json
{
  "dependencies": { "dsh-relay": "link:/path/to/deepseek-harness/plugins/relay" },
  "dsh": { "profile": { "bundles": ["...", "dsh-relay"] } }
}
```

Then restart `dsh` (or let HMR reload the profile). The plugin lives outside the pnpm workspace and is plain ESM JavaScript; there is no build step.

## Known limitations

- **Same process only** — delivery reaches Sessions resident in this Harness process. A durable mailbox and lease protocol for several processes are out of scope.
- **Same page only** — the flight effect addresses the current browser page; a second window does not receive it.
- **Cold reads use the log** — `session_read` on a cold Session returns messages in log order; compaction replacements are not re-projected.
- **Archive is opt-in** — archiving changes the user's sidebar and is disabled by default.
