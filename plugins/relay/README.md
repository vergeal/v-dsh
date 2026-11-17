# Relay

Cross-session messaging for DeepSeek Harness. The model can discover, read, activate, message, create, fork, interrupt, rename, and archive Sessions; the Web GUI plays a paper-plane delivery effect when a message is sent.

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

## Paper-plane effect

The browser half reads successful `session_send` results from the current Session and:

1. flies a paper plane with a fading light trail from the composer to the target Session row in the sidebar (1.5 s), then
2. pulses the landing point and shows a short received badge on the row.

If the target row is not in the sidebar, the plane lands at the sidebar edge. The effect needs the sender Session open in the same browser page; it does not synchronize across windows. `prefers-reduced-motion` reduces it to a short pulse. The effect depends on nothing in the Host: disabling `client.js` leaves delivery unchanged.

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
