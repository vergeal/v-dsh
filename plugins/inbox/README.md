# Inbox

Adds an **Inbox** entry to the DSH sidebar beside **Plugins** and **Automation tasks**. Selecting it opens the Inbox panel in the main column; selecting another entry leaves it.

## What the panel shows

Nine **simulated** items in three kinds, so the entry can be tried before a real source exists. A notice above the list says the data is simulated.

| Kind | Items | Statuses used |
|---|---|---|
| Email | 3 | Reply needed, Confirm, No action |
| Tasks | 3 | In progress, Not started, Done |
| IT tickets | 3 | Investigating, Pending, Awaiting approval |

Each row carries a kind glyph, title, source line, status pill, and time. The header states the total and unread counts.

Selecting a row opens that item's own detail page in place of the list. Every one of the nine pages has different content:

| Kind | Metadata rows | Sections | Extra block |
|---|---|---|---|
| Email | Sender, recipients, attachments | Scheduling and open items, or what changes and the decision needed | Attachment list with file names and sizes |
| Task | Workspace, deadline, related session | Scope and structure, or remaining questions and who confirms | Checklist with completed and open items |
| IT ticket | Ticket id, priority, assignee | Symptom and diagnosis, plan, request and approval | Activity log with time and actor |

The page shows the item's kind, status, and time under its title, and moves focus to the title.

## Interactions

- **Selecting a row** opens its detail page and marks the item read: the dot disappears and the title drops to the read weight.
- **Back to inbox** in the detail page's top-left corner returns to the list; `Esc` does the same. The filter and read state survive the round trip.
- **Filter tabs** narrow the list to one kind; the count beside each tab is the total for that kind.
- **Mark all as read** clears every unread dot in one step and disables itself once nothing is unread.

Read state is component state: it resets when the panel unmounts or the app reloads. Nothing here is persisted, and nothing is sent anywhere.

## Not implemented

No real source delivers items yet: no Host service, no persistence, no read state on the Host, and no badge on the sidebar entry. The nine items live in `client.js` and every visit starts from the same set.

## Layout

```
index.js            Host half; registers nothing, so the row loads without dependencies
client.js           Browser half: sidebar entry icon, main panel page, item set, dictionaries
cordis.patch.yml    Loader patch inserting the `inbox` row
locale/en.json      Plugin Manager title and description
locale/zh.json      Chinese title and description
icon.svg            Icon shown in Plugin Manager and plugin rows
```

The package lives outside `packages/` and outside the pnpm workspace, so repository builds and type checks ignore it. Install it with **Plugins** › **Add plugin** and this directory, or with the `plugin_manager` `install_bundle` action.
