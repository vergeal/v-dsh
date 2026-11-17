/**
 * Browser half of the Inbox bundle: the sidebar entry, the message list, and
 * the detail page each message opens.
 *
 * The sidebar owns the navigation button and resolves its text from the entry
 * label, so this module registers the icon for `sidebar.panellist` and the page
 * for the matching `main` key. Both registrations ride `ctx.slots.inject`, so
 * they install when the sidebar and layout declarations are present and
 * disappear with them.
 *
 * The items below are a local demonstration set: the plugin has no source that
 * delivers real entries yet, so nothing is persisted and every visit starts
 * from the same nine items. Read state lives in component state and resets when
 * the panel unmounts.
 */
window.__ModuleLoader__.load({
  id: 'dsh-inbox',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace owned by this plugin. */
    const NS = 'inbox'
    /** Identity shared by the sidebar entry and its main-panel occupant. */
    const PANEL_ID = 'inbox'
    /** Class prefix keeps every rule inside this plugin's own scope. */
    const PREFIX = 'dsh-inbox'

    /** Filter order and the dictionary key of each tab label. */
    const FILTERS = [
      { id: 'all', label: 'filter.all' },
      { id: 'email', label: 'filter.email' },
      { id: 'todo', label: 'filter.todo' },
      { id: 'ticket', label: 'filter.ticket' },
    ]

    /**
     * Demonstration entries. Every item carries its own detail page: metadata
     * rows, two body sections, and one kind-specific block — attachments for
     * email, a checklist for a task, and an activity log for a ticket.
     */
    const ITEMS = [
      {
        id: 'mail-budget', kind: 'email', unread: true, tone: 'warn', status: 'status.reply',
        fields: [['field.from', 'demo.mail-budget.f1'], ['field.to', 'demo.mail-budget.f2'], ['field.attachments', 'demo.mail-budget.f3']],
        sections: [['section.schedule', 'demo.mail-budget.s1'], ['section.openItems', 'demo.mail-budget.s2']],
        attachments: ['demo.mail-budget.a1', 'demo.mail-budget.a2'],
      },
      {
        id: 'mail-quota', kind: 'email', unread: true, tone: 'warn', status: 'status.confirm',
        fields: [['field.from', 'demo.mail-quota.f1'], ['field.to', 'demo.mail-quota.f2'], ['field.attachments', 'demo.mail-quota.f3']],
        sections: [['section.whatChanges', 'demo.mail-quota.s1'], ['section.yourCall', 'demo.mail-quota.s2']],
        attachments: ['demo.mail-quota.a1'],
      },
      {
        id: 'mail-ci', kind: 'email', unread: false, tone: 'idle', status: 'status.none',
        fields: [['field.from', 'demo.mail-ci.f1'], ['field.to', 'demo.mail-ci.f2'], ['field.attachments', 'demo.mail-ci.f3']],
        sections: [['section.failure', 'demo.mail-ci.s1'], ['section.impact', 'demo.mail-ci.s2']],
        attachments: ['demo.mail-ci.a1'],
      },
      {
        id: 'todo-spec', kind: 'todo', unread: true, tone: 'active', status: 'status.doing',
        fields: [['field.workspace', 'demo.todo-spec.f1'], ['field.deadline', 'demo.todo-spec.f2'], ['field.session', 'demo.todo-spec.f3']],
        sections: [['section.scope', 'demo.todo-spec.s1'], ['section.structure', 'demo.todo-spec.s2']],
        checklist: [
          { text: 'demo.todo-spec.c1', done: true },
          { text: 'demo.todo-spec.c2', done: true },
          { text: 'demo.todo-spec.c3', done: false },
          { text: 'demo.todo-spec.c4', done: false },
        ],
      },
      {
        id: 'todo-audit', kind: 'todo', unread: false, tone: 'idle', status: 'status.todo',
        fields: [['field.workspace', 'demo.todo-audit.f1'], ['field.deadline', 'demo.todo-audit.f2'], ['field.session', 'demo.todo-audit.f3']],
        sections: [['section.remaining', 'demo.todo-audit.s1'], ['section.whoConfirms', 'demo.todo-audit.s2']],
        checklist: [
          { text: 'demo.todo-audit.c1', done: true },
          { text: 'demo.todo-audit.c2', done: true },
          { text: 'demo.todo-audit.c3', done: false },
          { text: 'demo.todo-audit.c4', done: false },
        ],
      },
      {
        id: 'todo-verify', kind: 'todo', unread: false, tone: 'done', status: 'status.done',
        fields: [['field.workspace', 'demo.todo-verify.f1'], ['field.deadline', 'demo.todo-verify.f2'], ['field.session', 'demo.todo-verify.f3']],
        sections: [['section.steps', 'demo.todo-verify.s1'], ['section.results', 'demo.todo-verify.s2']],
        checklist: [
          { text: 'demo.todo-verify.c1', done: true },
          { text: 'demo.todo-verify.c2', done: true },
          { text: 'demo.todo-verify.c3', done: true },
          { text: 'demo.todo-verify.c4', done: false },
        ],
      },
      {
        id: 'ticket-vpn', kind: 'ticket', unread: true, tone: 'active', status: 'status.processing',
        fields: [['field.ticket', 'demo.ticket-vpn.f1'], ['field.priority', 'demo.ticket-vpn.f2'], ['field.assignee', 'demo.ticket-vpn.f3']],
        sections: [['section.symptom', 'demo.ticket-vpn.s1'], ['section.diagnosis', 'demo.ticket-vpn.s2']],
        timeline: [
          { time: 'demo.ticket-vpn.e1t', text: 'demo.ticket-vpn.e1' },
          { time: 'demo.ticket-vpn.e2t', text: 'demo.ticket-vpn.e2' },
          { time: 'demo.ticket-vpn.e3t', text: 'demo.ticket-vpn.e3' },
        ],
      },
      {
        id: 'ticket-driver', kind: 'ticket', unread: false, tone: 'warn', status: 'status.pending',
        fields: [['field.ticket', 'demo.ticket-driver.f1'], ['field.priority', 'demo.ticket-driver.f2'], ['field.assignee', 'demo.ticket-driver.f3']],
        sections: [['section.symptom', 'demo.ticket-driver.s1'], ['section.plan', 'demo.ticket-driver.s2']],
        timeline: [
          { time: 'demo.ticket-driver.e1t', text: 'demo.ticket-driver.e1' },
          { time: 'demo.ticket-driver.e2t', text: 'demo.ticket-driver.e2' },
          { time: 'demo.ticket-driver.e3t', text: 'demo.ticket-driver.e3' },
        ],
      },
      {
        id: 'ticket-quota', kind: 'ticket', unread: false, tone: 'warn', status: 'status.approval',
        fields: [['field.ticket', 'demo.ticket-quota.f1'], ['field.priority', 'demo.ticket-quota.f2'], ['field.assignee', 'demo.ticket-quota.f3']],
        sections: [['section.request', 'demo.ticket-quota.s1'], ['section.approval', 'demo.ticket-quota.s2']],
        timeline: [
          { time: 'demo.ticket-quota.e1t', text: 'demo.ticket-quota.e1' },
          { time: 'demo.ticket-quota.e2t', text: 'demo.ticket-quota.e2' },
          { time: 'demo.ticket-quota.e3t', text: 'demo.ticket-quota.e3' },
        ],
      },
    ]

    const STYLES = `
.${PREFIX}-page {
  display: flex;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-base);
  font-size: 14px;
  line-height: 1.6;
}
.${PREFIX}-scroll {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  overflow: auto;
  scrollbar-gutter: stable;
}
.${PREFIX}-content {
  display: flex;
  flex: 1 0 auto;
  flex-direction: column;
  width: 100%;
  max-width: 960px;
  margin: 0 auto;
  padding: 0 clamp(24px, 4vw, 48px) 48px;
}
@media (max-width: 767px) {
  .${PREFIX}-content { padding-inline: 20px; }
}
.${PREFIX}-heading {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding-top: 28px;
  margin-bottom: 16px;
}
[data-platform='darwin'] .${PREFIX}-heading,
[data-platform='darwin'] .${PREFIX}-detailTop {
  padding-top: calc(28px + var(--dsh-frame-top-clearance, 0px));
}
.${PREFIX}-heading h1 {
  margin: 0;
  font-size: 20px;
  line-height: 28px;
  font-weight: 500;
}
.${PREFIX}-summary {
  margin: 4px 0 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 13px;
  line-height: 20px;
}
.${PREFIX}-markAll {
  flex: none;
  padding: 4px 12px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 14px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  cursor: pointer;
}
.${PREFIX}-markAll:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.${PREFIX}-markAll:disabled { opacity: 0.5; cursor: default; }
.${PREFIX}-notice {
  display: flex;
  flex: none;
  align-items: flex-start;
  gap: 8px;
  margin-bottom: 16px;
  padding: 10px 12px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 20px;
}
.${PREFIX}-noticeGlyph { flex: none; margin-top: 2px; }
.${PREFIX}-filters {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 8px;
}
.${PREFIX}-tab {
  padding: 4px 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  cursor: pointer;
}
.${PREFIX}-tab:hover { background: var(--dsw-alias-interactive-bg-hover); }
.${PREFIX}-tabActive,
.${PREFIX}-tabActive:hover {
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font-weight: 500;
}
.${PREFIX}-list {
  flex: 1;
  margin: 0;
  padding: 0 0 8px;
  list-style: none;
}
.${PREFIX}-row {
  display: flex;
  width: 100%;
  align-items: flex-start;
  gap: 12px;
  padding: 12px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.${PREFIX}-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.${PREFIX}-row:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
.${PREFIX}-rowGlyph {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  color: var(--dsw-alias-label-secondary);
}
.${PREFIX}-rowBody {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.${PREFIX}-titleLine {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.${PREFIX}-title {
  overflow: hidden;
  color: var(--dsw-alias-label-secondary);
  font-size: 14px;
  line-height: 20px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.${PREFIX}-titleUnread {
  color: var(--dsw-alias-label-primary);
  font-weight: 500;
}
.${PREFIX}-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--dsw-alias-state-business-primary);
}
.${PREFIX}-meta {
  overflow: hidden;
  color: var(--dsw-alias-label-tertiary);
  font-size: 13px;
  line-height: 20px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.${PREFIX}-trailing {
  display: flex;
  flex: none;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
}
.${PREFIX}-time {
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
  white-space: nowrap;
}
.${PREFIX}-pill {
  padding: 0 8px;
  border-radius: 9px;
  font-size: 12px;
  line-height: 18px;
  white-space: nowrap;
}
.${PREFIX}-pillWarn {
  color: var(--dsw-alias-state-warn-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent);
}
.${PREFIX}-pillActive {
  color: var(--dsw-alias-state-business-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent);
}
.${PREFIX}-pillDone {
  color: var(--dsw-alias-state-success-primary);
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent);
}
.${PREFIX}-pillIdle {
  color: var(--dsw-alias-label-secondary);
  background: color-mix(in srgb, var(--dsw-alias-label-secondary) 10%, transparent);
}
.${PREFIX}-srOnly {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}
.${PREFIX}-detail {
  display: flex;
  flex: 1 0 auto;
  flex-direction: column;
  gap: 24px;
}
.${PREFIX}-detailTop {
  display: flex;
  flex: none;
  align-items: center;
  padding-top: 20px;
  margin-bottom: 20px;
}
.${PREFIX}-back {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: -10px;
  padding: 4px 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  cursor: pointer;
}
.${PREFIX}-back:hover { background: var(--dsw-alias-interactive-bg-hover); }
.${PREFIX}-detailTitle {
  margin: 0;
  font-size: 20px;
  line-height: 28px;
  font-weight: 500;
}
.${PREFIX}-detailMeta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}
.${PREFIX}-detailKind {
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 18px;
}
.${PREFIX}-fields {
  display: grid;
  grid-template-columns: 88px minmax(0, 1fr);
  gap: 8px 16px;
  margin: 0;
  padding: 14px 16px;
  border-radius: 10px;
  background: var(--dsw-alias-interactive-bg-hover);
  font-size: 13px;
  line-height: 20px;
}
.${PREFIX}-field { display: contents; }
.${PREFIX}-fields dt {
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
}
.${PREFIX}-fields dd {
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--dsw-alias-label-primary);
}
.${PREFIX}-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.${PREFIX}-section h2 {
  margin: 0;
  font-size: 14px;
  line-height: 20px;
  font-weight: 500;
}
.${PREFIX}-section p {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 14px;
  line-height: 22px;
}
.${PREFIX}-attachments,
.${PREFIX}-checklist,
.${PREFIX}-timeline {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary);
}
.${PREFIX}-attachment {
  display: inline-flex;
  align-self: flex-start;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
}
.${PREFIX}-attachment svg { flex: none; color: var(--dsw-alias-label-tertiary); }
.${PREFIX}-check {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.${PREFIX}-checkBox {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  margin-top: 3px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 4px;
  color: var(--dsw-alias-brand-primary);
}
.${PREFIX}-checkBox[data-done] {
  border-color: transparent;
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent);
}
.${PREFIX}-checkDone {
  color: var(--dsw-alias-label-tertiary);
  text-decoration: line-through;
}
.${PREFIX}-timeline {
  margin-left: 5px;
  padding-left: 16px;
  border-left: 1px solid var(--dsw-alias-border-l1);
}
.${PREFIX}-event {
  position: relative;
  display: grid;
  grid-template-columns: 72px minmax(0, 1fr);
  gap: 12px;
}
.${PREFIX}-event::before {
  content: '';
  position: absolute;
  left: -19.5px;
  top: 7px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--dsw-alias-label-tertiary);
}
.${PREFIX}-eventTime {
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 20px;
}
`

    /**
     * Draw the inbox tray at the edge the caller asks for.
     * @param {object} props - the requested square edge.
     * @returns {object} decorative tray glyph.
     */
    function InboxGlyph({ size }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      },
      h('path', { d: 'M2 9.5H5.15L6.15 11.5H9.85L10.85 9.5H14' }),
      h('path', { d: 'M2 9.5V12.3C2 13.02 2.58 13.6 3.3 13.6H12.7C13.42 13.6 14 13.02 14 12.3V9.5' }),
      h('path', { d: 'M2 9.5L3.95 3.95C4.14 3.4 4.65 3.05 5.22 3.05H10.78C11.35 3.05 11.86 3.4 12.05 3.95L14 9.5' }))
    }

    /**
     * Draw the envelope standing for an email item.
     * @param {object} props - the requested square edge.
     * @returns {object} decorative envelope glyph.
     */
    function MailGlyph({ size }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      },
      h('path', { d: 'M3.5 3.5H12.5C13.05 3.5 13.5 3.95 13.5 4.5V11.5C13.5 12.05 13.05 12.5 12.5 12.5H3.5C2.95 12.5 2.5 12.05 2.5 11.5V4.5C2.5 3.95 2.95 3.5 3.5 3.5Z' }),
      h('path', { d: 'M2.8 4.2L7.7 8.1C7.87 8.23 8.13 8.23 8.3 8.1L13.2 4.2' }))
    }

    /**
     * Draw the checklist standing for a task item.
     * @param {object} props - the requested square edge.
     * @returns {object} decorative checklist glyph.
     */
    function TaskGlyph({ size }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      },
      h('path', { d: 'M2.5 5H8.5' }),
      h('path', { d: 'M2.5 8H6.5' }),
      h('path', { d: 'M2.5 11H5.5' }),
      h('path', { d: 'M9 10.2L10.6 11.8L13.9 8.4' }))
    }

    /**
     * Draw the hang tag standing for an IT ticket.
     * @param {object} props - the requested square edge.
     * @returns {object} decorative tag glyph.
     */
    function TicketGlyph({ size }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      },
      h('path', { d: 'M8.2 2.5H13.5V7.8L7.5 13.8L2.2 8.5L8.2 2.5Z' }),
      h('circle', { cx: 11, cy: 5, r: 0.9 }))
    }

    /**
     * Draw the information mark beside the sample-data notice.
     * @param {object} props - the requested square edge.
     * @returns {object} decorative information glyph.
     */
    function InfoGlyph({ size }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      },
      h('circle', { cx: 8, cy: 8, r: 6 }),
      h('path', { d: 'M8 7.2V11' }),
      h('path', { d: 'M8 4.9V5' }))
    }

    /**
     * Draw the arrow that leaves a detail page.
     * @param {object} props - the requested square edge.
     * @returns {object} decorative back arrow.
     */
    function BackGlyph({ size }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      },
      h('path', { d: 'M12.5 8H3.5' }),
      h('path', { d: 'M7 4.5L3.5 8L7 11.5' }))
    }

    /**
     * Draw the file mark beside an attachment name.
     * @param {object} props - the requested square edge.
     * @returns {object} decorative file glyph.
     */
    function FileGlyph({ size }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      },
      h('path', { d: 'M4 2.5H9L12 5.5V13.5H4V2.5Z' }),
      h('path', { d: 'M9 2.5V5.5H12' }))
    }

    /**
     * Draw the check inside a completed checklist row.
     * @param {object} props - the requested square edge.
     * @returns {object} decorative check glyph.
     */
    function CheckGlyph({ size }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 12 12', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      },
      h('path', { d: 'M2 6.2L4.6 8.8L10 3.2' }))
    }

    /** Kind-to-glyph table; an unknown kind falls back to the inbox tray. */
    const GLYPHS = { email: MailGlyph, todo: TaskGlyph, ticket: TicketGlyph }

    /** Kind-to-label table, reusing the filter tab dictionary keys. */
    const KIND_LABELS = { email: 'filter.email', todo: 'filter.todo', ticket: 'filter.ticket' }

    /**
     * Map an item's status tone to the pill class suffix.
     * @param {string} tone - `warn`, `active`, `done`, or `idle`.
     * @returns {string} capitalized class suffix.
     */
    function toneName(tone) {
      return tone === 'warn' ? 'Warn' : tone === 'active' ? 'Active' : tone === 'done' ? 'Done' : 'Idle'
    }

    /**
     * Render one message's detail page.
     * @param {object} props - locale seat, the item, and the leave callback.
     * @returns {object} the detail page.
     */
    function InboxDetail({ t, item, onBack }) {
      const heading = React.useRef(null)
      React.useEffect(() => { heading.current?.focus() }, [item.id])
      const Glyph = GLYPHS[item.kind] ?? InboxGlyph
      const body = key => t(key).split(/\n{2,}/).map((paragraph, index) => h('p', { key: index }, paragraph))

      return h('article', { className: `${PREFIX}-detail` },
        h('div', { className: `${PREFIX}-detailTop` },
          h('button', { type: 'button', className: `${PREFIX}-back`, onClick: onBack },
            h(BackGlyph, { size: 14 }),
            t('detail.back'))),
        h('header', null,
          h('h1', { ref: heading, tabIndex: -1, className: `${PREFIX}-detailTitle` }, t(`demo.${item.id}.title`)),
          h('div', { className: `${PREFIX}-detailMeta` },
            h('span', { className: `${PREFIX}-detailKind` }, h(Glyph, { size: 12 }), t(KIND_LABELS[item.kind])),
            h('span', { className: `${PREFIX}-pill ${PREFIX}-pill${toneName(item.tone)}` }, t(item.status)),
            h('span', { className: `${PREFIX}-time` }, t(`demo.${item.id}.time`)))),
        h('dl', { className: `${PREFIX}-fields` },
          item.fields.map(([label, value]) => h('div', { className: `${PREFIX}-field`, key: label },
            h('dt', null, t(label)),
            h('dd', null, t(value))))),
        item.sections.map(([title, bodyKey]) => h('section', { className: `${PREFIX}-section`, key: title },
          h('h2', null, t(title)),
          body(bodyKey))),
        item.attachments === undefined
          ? null
          : h('section', { className: `${PREFIX}-section` },
            h('h2', null, t('section.attachments')),
            h('ul', { className: `${PREFIX}-attachments` },
              item.attachments.map(key => h('li', { className: `${PREFIX}-attachment`, key },
                h(FileGlyph, { size: 14 }),
                h('span', null, t(key)))))),
        item.checklist === undefined
          ? null
          : h('section', { className: `${PREFIX}-section` },
            h('h2', null, t('section.checklist')),
            h('ul', { className: `${PREFIX}-checklist` },
              item.checklist.map(entry => h('li', { className: `${PREFIX}-check`, key: entry.text },
                h('span', { className: `${PREFIX}-checkBox`, 'data-done': entry.done ? '' : undefined },
                  entry.done ? h(CheckGlyph, { size: 10 }) : null),
                h('span', { className: entry.done ? `${PREFIX}-checkDone` : undefined }, t(entry.text)),
                entry.done ? h('span', { className: `${PREFIX}-srOnly` }, t('a11y.done')) : null)))),
        item.timeline === undefined
          ? null
          : h('section', { className: `${PREFIX}-section` },
            h('h2', null, t('section.activity')),
            h('ol', { className: `${PREFIX}-timeline` },
              item.timeline.map(entry => h('li', { className: `${PREFIX}-event`, key: entry.text },
                h('span', { className: `${PREFIX}-eventTime` }, t(entry.time)),
                h('span', null, t(entry.text)))))))
    }

    /**
     * Render the Inbox panel: the message list, or the detail page of the
     * message the user opened.
     * @param {object} props - framework locale seat for this registration.
     * @returns {object} the inbox page.
     */
    function InboxPage({ t }) {
      const [readIds, setReadIds] = React.useState(() => new Set())
      const [filter, setFilter] = React.useState('all')
      const [selectedId, setSelectedId] = React.useState(null)

      const isUnread = item => item.unread && !readIds.has(item.id)
      const unreadCount = ITEMS.filter(isUnread).length
      const rows = filter === 'all' ? ITEMS : ITEMS.filter(item => item.kind === filter)
      const countOf = kind => kind === 'all' ? ITEMS.length : ITEMS.filter(item => item.kind === kind).length
      const selected = selectedId === null ? null : ITEMS.find(item => item.id === selectedId)

      const markRead = (id) => {
        setReadIds((previous) => {
          if (previous.has(id)) return previous
          const next = new Set(previous)
          next.add(id)
          return next
        })
      }

      const openItem = (item) => {
        markRead(item.id)
        setSelectedId(item.id)
      }

      const leaveDetail = () => { setSelectedId(null) }

      return h('section', {
        className: `${PREFIX}-page`,
        'aria-label': t('title'),
        onKeyDown: (event) => {
          if (event.key !== 'Escape' || selected === null) return
          event.preventDefault()
          event.stopPropagation()
          leaveDetail()
        },
      },
      h('style', { key: 'styles', dangerouslySetInnerHTML: { __html: STYLES } }),
      h('div', { className: `${PREFIX}-scroll` },
        h('div', { className: `${PREFIX}-content` },
          selected === null
            ? [
              h('div', { className: `${PREFIX}-heading`, key: 'heading' },
                h('div', null,
                  h('h1', { tabIndex: -1 }, t('title')),
                  h('p', { className: `${PREFIX}-summary` }, t('summary', { total: ITEMS.length, unread: unreadCount }))),
                h('button', {
                  type: 'button',
                  className: `${PREFIX}-markAll`,
                  disabled: unreadCount === 0,
                  onClick: () => { setReadIds(new Set(ITEMS.map(item => item.id))) },
                }, t('markAll'))),
              h('div', { className: `${PREFIX}-notice`, key: 'notice' },
                h('span', { className: `${PREFIX}-noticeGlyph` }, h(InfoGlyph, { size: 16 })),
                h('span', null, t('notice'))),
              h('div', {
                className: `${PREFIX}-filters`,
                role: 'group',
                'aria-label': t('filters.label'),
                key: 'filters',
              },
              FILTERS.map(tab => h('button', {
                key: tab.id,
                type: 'button',
                className: `${PREFIX}-tab${filter === tab.id ? ` ${PREFIX}-tabActive` : ''}`,
                'aria-pressed': filter === tab.id,
                onClick: () => { setFilter(tab.id) },
              }, `${t(tab.label)} ${countOf(tab.id)}`))),
              h('ul', { className: `${PREFIX}-list`, key: 'list' }, rows.map((item) => {
                const unread = isUnread(item)
                const Glyph = GLYPHS[item.kind] ?? InboxGlyph
                return h('li', { key: item.id },
                  h('button', {
                    type: 'button',
                    className: `${PREFIX}-row`,
                    onClick: () => { openItem(item) },
                  },
                  h('span', { className: `${PREFIX}-rowGlyph` }, h(Glyph, { size: 16 })),
                  h('span', { className: `${PREFIX}-rowBody` },
                    h('span', { className: `${PREFIX}-titleLine` },
                      h('span', { className: `${PREFIX}-title${unread ? ` ${PREFIX}-titleUnread` : ''}` }, t(`demo.${item.id}.title`)),
                      unread ? h('span', { className: `${PREFIX}-srOnly` }, t('a11y.unread')) : null,
                      unread ? h('span', { className: `${PREFIX}-dot`, 'aria-hidden': true }) : null),
                    h('span', { className: `${PREFIX}-meta` }, t(`demo.${item.id}.meta`))),
                  h('span', { className: `${PREFIX}-trailing` },
                    h('span', { className: `${PREFIX}-pill ${PREFIX}-pill${toneName(item.tone)}` }, t(item.status)),
                    h('span', { className: `${PREFIX}-time` }, t(`demo.${item.id}.time`)))))
              })),
            ]
            : h(InboxDetail, { key: 'detail', t, item: selected, onBack: leaveDetail }))))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, 'en', {
          panel: 'Inbox',
          title: 'Inbox',
          summary: '{total} items · {unread} unread',
          markAll: 'Mark all as read',
          notice: 'Sample data: these items are simulated inside the plugin. No real source is connected yet.',
          'filters.label': 'Filter',
          'filter.all': 'All',
          'filter.email': 'Email',
          'filter.todo': 'Tasks',
          'filter.ticket': 'IT tickets',
          'a11y.unread': 'Unread',
          'a11y.done': 'Done',
          'detail.back': 'Back to inbox',
          'status.reply': 'Reply needed',
          'status.confirm': 'Confirm',
          'status.none': 'No action',
          'status.doing': 'In progress',
          'status.todo': 'Not started',
          'status.done': 'Done',
          'status.processing': 'Investigating',
          'status.pending': 'Pending',
          'status.approval': 'Awaiting approval',
          'field.from': 'From',
          'field.to': 'To',
          'field.attachments': 'Attachments',
          'field.workspace': 'Workspace',
          'field.deadline': 'Deadline',
          'field.session': 'Session',
          'field.ticket': 'Ticket',
          'field.priority': 'Priority',
          'field.assignee': 'Assignee',
          'section.schedule': 'Schedule',
          'section.openItems': 'Open items',
          'section.whatChanges': 'What changes',
          'section.yourCall': 'Your decision',
          'section.failure': 'Failure detail',
          'section.impact': 'Impact',
          'section.scope': 'Scope',
          'section.structure': 'Structure',
          'section.remaining': 'Remaining questions',
          'section.whoConfirms': 'Who confirms',
          'section.steps': 'Steps',
          'section.results': 'Results so far',
          'section.symptom': 'Symptom',
          'section.diagnosis': 'Diagnosis and plan',
          'section.plan': 'Plan',
          'section.request': 'Request',
          'section.approval': 'Approval and setup',
          'section.attachments': 'Attachments',
          'section.checklist': 'Checklist',
          'section.activity': 'Activity',
          'demo.mail-budget.title': 'Q4 budget review pack',
          'demo.mail-budget.meta': 'From Zhang Wei · Finance',
          'demo.mail-budget.time': '10:24',
          'demo.mail-budget.f1': 'Zhang Wei <zhangwei@changhong.com>',
          'demo.mail-budget.f2': 'Me, Li Na, Finance',
          'demo.mail-budget.f3': '2 attachments',
          'demo.mail-budget.s1': 'The review is on Friday at 14:00 in meeting room 3 and runs about 90 minutes.\n\nFinance, HRBP, and the team leads attend; the goal is to settle the three counting differences and write them down.',
          'demo.mail-budget.s2': 'Travel expenses are currently allocated two ways, per head and per project, and one has to win.\n\nOutsourced headcount needs a ruling with HRBP so it is not counted twice, and the archived test-environment resources are best owned by the platform team.',
          'demo.mail-budget.a1': 'Q4 budget tracker.xlsx · 420 KB',
          'demo.mail-budget.a2': 'Counting differences.docx · 96 KB',
          'demo.mail-quota.title': 'Model API quota changes next week',
          'demo.mail-quota.meta': 'From supplier support · System notice',
          'demo.mail-quota.time': 'Yesterday 18:02',
          'demo.mail-quota.f1': 'Supplier support <support@hongxincy.com>',
          'demo.mail-quota.f2': 'Me, Procurement',
          'demo.mail-quota.f3': '1 attachment',
          'demo.mail-quota.s1': 'The new quota starts on December 1. The base allowance is unchanged and the excess bills in three tiers.\n\nThe concurrency cap stays at the old contract value of 20 and needs written confirmation by November 28.',
          'demo.mail-quota.s2': 'Keep the current concurrency and billing, or move to pay-as-you-go to cut the fixed cost.\n\nUsage peaks around 60% of the quota, so keeping it as it is covers the evaluation work for now.',
          'demo.mail-quota.a1': 'Quota and billing notes.pdf · 1.2 MB',
          'demo.mail-ci.title': 'Nightly build failed twice',
          'demo.mail-ci.meta': 'From CI bot',
          'demo.mail-ci.time': 'Yesterday 09:15',
          'demo.mail-ci.f1': 'CI bot <ci@build.local>',
          'demo.mail-ci.f2': 'Me',
          'demo.mail-ci.f3': '1 attachment',
          'demo.mail-ci.s1': 'Both failures are in the signing step of the desktop packaging job; the log reports a missing CSC_LINK environment variable.\n\nThe failures started at 02:10 last night and reproduce on the previous build, so they are unrelated to this change.',
          'demo.mail-ci.s2': 'No installer was produced overnight; manual builds during the day are unaffected.\n\nNo action is needed because the next build window retries, but a manual build verifies it sooner.',
          'demo.mail-ci.a1': 'build-2418.log · 3.6 MB',
          'demo.todo-spec.title': 'Draft the plugin development guide',
          'demo.todo-spec.meta': 'Workspace DSH · due today 18:00',
          'demo.todo-spec.time': 'Today 09:30',
          'demo.todo-spec.f1': 'DSH',
          'demo.todo-spec.f2': 'Today 18:00',
          'demo.todo-spec.f3': 'Plugin development guide (draft session)',
          'demo.todo-spec.s1': 'The draft covers three sections: sidebar entry, slot registration, and localization, each within one screen.\n\nThe sidebar section pairs sidebar.panellist with main; the slot section covers ctx.slots.inject timing and disposal; the localization section covers dictionary registration and label thunks.',
          'demo.todo-spec.s2': 'Each section starts with a copy-ready minimal example, then explains the extension point.\n\nNo unlabelled API may appear: every function used in an example must exist in the current version source.',
          'demo.todo-spec.c1': 'Sidebar entry section',
          'demo.todo-spec.c2': 'Slot registration section',
          'demo.todo-spec.c3': 'Localization section',
          'demo.todo-spec.c4': 'Two minimal examples and screenshots',
          'demo.todo-audit.title': 'Answer the security audit questionnaire',
          'demo.todo-audit.meta': 'Workspace Changhong OA · due Friday',
          'demo.todo-audit.time': 'In 2 days',
          'demo.todo-audit.f1': 'Changhong OA',
          'demo.todo-audit.f2': 'Friday',
          'demo.todo-audit.f3': 'Questionnaire SEC-2026-Q4',
          'demo.todo-audit.s1': 'The questionnaire has 30 questions; 18 are answered and 12 remain: seven on data retention and five on third-party dependencies.\n\nRetention needs the session-log period, the export boundary, and the deletion process confirmed.',
          'demo.todo-audit.s2': 'Product and legal confirm retention; the platform team supplies the browser-side package list.\n\nAnswers go out once both sides agree, so nothing contradicts.',
          'demo.todo-audit.c1': 'Retention period',
          'demo.todo-audit.c2': 'Export boundary',
          'demo.todo-audit.c3': 'Browser-side package list',
          'demo.todo-audit.c4': 'Third-party SDK sources',
          'demo.todo-verify.title': 'Verify the 0.2.2-rc.3 desktop upgrade path',
          'demo.todo-verify.meta': 'Workspace DSH · session DSH/PM',
          'demo.todo-verify.time': 'Yesterday 16:40',
          'demo.todo-verify.f1': 'DSH',
          'demo.todo-verify.f2': 'Yesterday 18:00',
          'demo.todo-verify.f3': 'Session DSH/PM',
          'demo.todo-verify.s1': 'Install 0.2.2-rc.3 over 0.2.2-rc.2 on a development build without deleting the application data directory.\n\nAfter installing, check that sessions open, plugin rows show the right state, model credentials work, and the language and theme settings survive.',
          'demo.todo-verify.s2': 'The macOS development build passed every check.\n\nThe Windows installer is still unverified and needs one run on the packaging machine.',
          'demo.todo-verify.c1': 'Install over the old version',
          'demo.todo-verify.c2': 'Sessions open',
          'demo.todo-verify.c3': 'Plugin rows correct',
          'demo.todo-verify.c4': 'Windows installer verified',
          'demo.ticket-vpn.title': 'INC-1042 VPN cannot connect',
          'demo.ticket-vpn.meta': 'Reported by Li Ming · Priority P2',
          'demo.ticket-vpn.time': '12:40',
          'demo.ticket-vpn.f1': 'INC-1042',
          'demo.ticket-vpn.f2': 'P2',
          'demo.ticket-vpn.f3': 'Me',
          'demo.ticket-vpn.s1': 'Li Ming cannot dial in from outside the office; the client stalls at credential verification while the office network works.\n\nOne user is affected. The ticket arrived today at 12:40 with a client screenshot attached.',
          'demo.ticket-vpn.s2': 'Account lockout and password expiry are ruled out, so the client certificate looks expired.\n\nPlan: reset the certificate and have the user import it again, about 15 minutes. Waiting for the user to confirm a window.',
          'demo.ticket-vpn.e1t': '12:40',
          'demo.ticket-vpn.e1': 'Li Ming filed the ticket with a screenshot.',
          'demo.ticket-vpn.e2t': '13:05',
          'demo.ticket-vpn.e2': 'I checked remotely: the account is active and the password is current.',
          'demo.ticket-vpn.e3t': '13:40',
          'demo.ticket-vpn.e3': 'I ruled it a certificate expiry and wait for the user to pick a reset window.',
          'demo.ticket-driver.title': 'INC-1038 printer driver missing',
          'demo.ticket-driver.meta': 'Reported by Wang Fang · Priority P3',
          'demo.ticket-driver.time': 'Yesterday 14:20',
          'demo.ticket-driver.f1': 'INC-1038',
          'demo.ticket-driver.f2': 'P3',
          'demo.ticket-driver.f3': 'Me',
          'demo.ticket-driver.s1': 'A newly imaged desk on the admin floor lacks the printer driver, which shows up as an unknown device.\n\nOne device is affected. Wang Fang filed it yesterday at 14:20 with the device number.',
          'demo.ticket-driver.s2': 'The package already exists in the internal software library; install it and restart the print service.\n\nIt can ride the next maintenance round, so no separate trip is needed.',
          'demo.ticket-driver.e1t': 'Yesterday 14:20',
          'demo.ticket-driver.e1': 'Wang Fang filed the ticket with the device number.',
          'demo.ticket-driver.e2t': 'Yesterday 15:02',
          'demo.ticket-driver.e2': 'I confirmed the driver exists in the internal software library.',
          'demo.ticket-driver.e3t': 'Yesterday 15:30',
          'demo.ticket-driver.e3': 'I scheduled it for the next maintenance round.',
          'demo.ticket-quota.title': 'REQ-207 5 more model quotas',
          'demo.ticket-quota.meta': 'Requested by Chen Chen · Priority P2',
          'demo.ticket-quota.time': 'Monday 11:05',
          'demo.ticket-quota.f1': 'REQ-207',
          'demo.ticket-quota.f2': 'P2',
          'demo.ticket-quota.f3': 'Platform team, Zhang Min',
          'demo.ticket-quota.s1': 'Chen Chen requested five more model quotas for the new business evaluation environment, to compare three candidate models.\n\nThe scope is the evaluation workspace only, so production quota is unaffected.',
          'demo.ticket-quota.s2': 'Administrator approval comes first; the platform team provisions the same day.\n\nThe evaluation runs about two weeks, then the quota is released.',
          'demo.ticket-quota.e1t': 'Monday 11:05',
          'demo.ticket-quota.e1': 'Chen Chen filed the request.',
          'demo.ticket-quota.e2t': 'Monday 14:20',
          'demo.ticket-quota.e2': 'I added the evaluation scope and duration.',
          'demo.ticket-quota.e3t': 'Today 09:10',
          'demo.ticket-quota.e3': 'The platform team is waiting for administrator approval.',
        }), 'dsh-inbox: en dictionary')

        ctx.effect(() => ctx.locale.register(NS, 'zh', {
          panel: '收件箱',
          title: '收件箱',
          summary: '共 {total} 条 · {unread} 条未读',
          markAll: '全部标为已读',
          notice: '示例数据：以下条目由插件本地模拟，尚未接入真实来源。',
          'filters.label': '筛选',
          'filter.all': '全部',
          'filter.email': '邮箱',
          'filter.todo': '待办',
          'filter.ticket': 'IT 工单',
          'a11y.unread': '未读',
          'a11y.done': '已完成',
          'detail.back': '返回收件箱',
          'status.reply': '待回复',
          'status.confirm': '待确认',
          'status.none': '无需处理',
          'status.doing': '进行中',
          'status.todo': '待开始',
          'status.done': '已完成',
          'status.processing': '处理中',
          'status.pending': '待处理',
          'status.approval': '待审批',
          'field.from': '发件人',
          'field.to': '收件人',
          'field.attachments': '附件',
          'field.workspace': '工作区',
          'field.deadline': '截止时间',
          'field.session': '关联会话',
          'field.ticket': '工单号',
          'field.priority': '优先级',
          'field.assignee': '处理人',
          'section.schedule': '会议安排',
          'section.openItems': '待确认口径',
          'section.whatChanges': '调整内容',
          'section.yourCall': '需要你确认',
          'section.failure': '失败详情',
          'section.impact': '影响与处理',
          'section.scope': '交付范围',
          'section.structure': '结构要求',
          'section.remaining': '剩余问题',
          'section.whoConfirms': '需要谁确认',
          'section.steps': '检查步骤',
          'section.results': '已知结果',
          'section.symptom': '现象',
          'section.diagnosis': '判断与方案',
          'section.plan': '处理方案',
          'section.request': '申请内容',
          'section.approval': '审批与开通',
          'section.attachments': '附件',
          'section.checklist': '检查项',
          'section.activity': '处理记录',
          'demo.mail-budget.title': 'Q4 预算复盘会材料',
          'demo.mail-budget.meta': '来自 张伟 · 财务组',
          'demo.mail-budget.time': '10:24',
          'demo.mail-budget.f1': '张伟 <zhangwei@changhong.com>',
          'demo.mail-budget.f2': '我、李娜、财务组',
          'demo.mail-budget.f3': '2 个附件',
          'demo.mail-budget.s1': '复盘会定在周五 14:00，3 号会议室，预计 90 分钟。\n\n参加人包括财务、HRBP 和各组负责人，目标是逐条确认三个口径差异并形成书面结论。',
          'demo.mail-budget.s2': '差旅报销按人头分摊还是按项目分摊，目前两种做法并存，需要会上定一个。\n\n外包人力的结转口径要和 HRBP 核对，避免重复计入；测试环境资源的归档归属建议统一归到平台组。',
          'demo.mail-budget.a1': 'Q4 预算执行表.xlsx · 420 KB',
          'demo.mail-budget.a2': '口径差异说明.docx · 96 KB',
          'demo.mail-quota.title': '模型 API 配额下周调整',
          'demo.mail-quota.meta': '来自 供应商支持 · 系统通知',
          'demo.mail-quota.time': '昨天 18:02',
          'demo.mail-quota.f1': '供应商支持 <support@hongxincy.com>',
          'demo.mail-quota.f2': '我、采购组',
          'demo.mail-quota.f3': '1 个附件',
          'demo.mail-quota.s1': '新配额从 12 月 1 日起生效，基础额度不变，超出部分按三档阶梯计费。\n\n并发上限沿用旧合同的 20，需要在 11 月 28 日前书面确认。',
          'demo.mail-quota.s2': '是保持现有并发与计费方式，还是改按量计费以降低固定成本。\n\n现有用量约为配额峰值的 60%，保持不变即可覆盖眼下的评测需求。',
          'demo.mail-quota.a1': '新配额与计费说明.pdf · 1.2 MB',
          'demo.mail-ci.title': '夜间构建失败 2 次',
          'demo.mail-ci.meta': '来自 CI 机器人',
          'demo.mail-ci.time': '昨天 09:15',
          'demo.mail-ci.f1': 'CI 机器人 <ci@build.local>',
          'demo.mail-ci.f2': '我',
          'demo.mail-ci.f3': '1 个附件',
          'demo.mail-ci.s1': '两次失败都发生在桌面端打包任务的签名步骤，日志报缺少环境变量 CSC_LINK。\n\n失败从昨晚 02:10 开始，前一版构建同样复现，与本轮改动无关。',
          'demo.mail-ci.s2': '夜间构建没有产出安装包，白天的手动构建不受影响。\n\n无需处理，下个构建窗口会自动重试；想提前验证可以手动触发一次。',
          'demo.mail-ci.a1': 'build-2418.log · 3.6 MB',
          'demo.todo-spec.title': '整理《插件开发规范》初稿',
          'demo.todo-spec.meta': '工作区 DSH · 今天 18:00 前',
          'demo.todo-spec.time': '今天 09:30',
          'demo.todo-spec.f1': 'DSH',
          'demo.todo-spec.f2': '今天 18:00',
          'demo.todo-spec.f3': '插件开发规范（草稿会话）',
          'demo.todo-spec.s1': '初稿覆盖侧边栏入口、槽位注册、本地化三节，每节控制在一屏以内。\n\n侧边栏入口说明 sidebar.panellist 与 main 的对应关系；槽位注册说明 ctx.slots.inject 的时序与销毁；本地化说明词典注册与标签 thunk 的写法。',
          'demo.todo-spec.s2': '每节先给一段能直接抄用的最小示例，再解释扩展点。\n\n不允许出现没有标注的 API：示例里用到的每个函数都要能在当前版本的源码里找到。',
          'demo.todo-spec.c1': '侧边栏入口一节',
          'demo.todo-spec.c2': '槽位注册一节',
          'demo.todo-spec.c3': '本地化一节',
          'demo.todo-spec.c4': '两个最小示例与截图',
          'demo.todo-audit.title': '回复安全审计问卷',
          'demo.todo-audit.meta': '工作区 长虹OA系统 · 周五截止',
          'demo.todo-audit.time': '2 天后',
          'demo.todo-audit.f1': '长虹OA系统',
          'demo.todo-audit.f2': '周五',
          'demo.todo-audit.f3': '问卷 SEC-2026-Q4',
          'demo.todo-audit.s1': '问卷共 30 题，已答 18 题，剩余 12 题分两类：数据留存 7 题，第三方依赖 5 题。\n\n数据留存需要确认会话日志的保存周期、导出边界和删除流程。',
          'demo.todo-audit.s2': '数据留存由产品与法务确认，第三方依赖由平台组提供浏览器端加载清单。\n\n两边的结论汇总后再统一作答，避免前后不一致。',
          'demo.todo-audit.c1': '数据留存周期',
          'demo.todo-audit.c2': '导出边界',
          'demo.todo-audit.c3': '浏览器端依赖清单',
          'demo.todo-audit.c4': '第三方 SDK 来源',
          'demo.todo-verify.title': '验证 0.2.2-rc.3 桌面端升级路径',
          'demo.todo-verify.meta': '工作区 DSH · 关联会话 DSH/PM',
          'demo.todo-verify.time': '昨天 16:40',
          'demo.todo-verify.f1': 'DSH',
          'demo.todo-verify.f2': '昨天 18:00',
          'demo.todo-verify.f3': '会话 DSH/PM',
          'demo.todo-verify.s1': '在开发机构建上从 0.2.2-rc.2 覆盖安装到 0.2.2-rc.3，不删除应用数据目录。\n\n安装后逐项检查：会话能否打开、插件行状态、模型凭据、语言与主题设置。',
          'demo.todo-verify.s2': 'macOS 开发机构建通过，全部检查项正常。\n\nWindows 安装包尚未验证，需要在打包机上补一次。',
          'demo.todo-verify.c1': '覆盖安装',
          'demo.todo-verify.c2': '会话可打开',
          'demo.todo-verify.c3': '插件行状态正确',
          'demo.todo-verify.c4': 'Windows 安装包验证',
          'demo.ticket-vpn.title': 'INC-1042 VPN 无法连接',
          'demo.ticket-vpn.meta': '报告人 李明 · 优先级 P2',
          'demo.ticket-vpn.time': '12:40',
          'demo.ticket-vpn.f1': 'INC-1042',
          'demo.ticket-vpn.f2': 'P2',
          'demo.ticket-vpn.f3': '我',
          'demo.ticket-vpn.s1': '李明在外网环境拨号失败，客户端停在“正在验证凭据”，办公室内网连接正常。\n\n影响 1 人，今天 12:40 提交，附客户端截图。',
          'demo.ticket-vpn.s2': '已排除账号锁定和密码过期，初步判断为客户端证书过期。\n\n方案：重置证书并让用户重新导入，预计 15 分钟；需要用户确认重置时间。',
          'demo.ticket-vpn.e1t': '12:40',
          'demo.ticket-vpn.e1': '李明提交工单，附客户端截图。',
          'demo.ticket-vpn.e2t': '13:05',
          'demo.ticket-vpn.e2': '我远程排查：账号状态正常，密码未过期。',
          'demo.ticket-vpn.e3t': '13:40',
          'demo.ticket-vpn.e3': '我判断为证书过期，等待用户确认重置时间。',
          'demo.ticket-driver.title': 'INC-1038 打印机驱动缺失',
          'demo.ticket-driver.meta': '报告人 王芳 · 优先级 P3',
          'demo.ticket-driver.time': '昨天 14:20',
          'demo.ticket-driver.f1': 'INC-1038',
          'demo.ticket-driver.f2': 'P3',
          'demo.ticket-driver.f3': '我',
          'demo.ticket-driver.s1': '行政楼层新装机的电脑缺少打印机驱动包，设备管理器里显示为未知设备。\n\n影响 1 台设备，昨天 14:20 由王芳提交，附设备编号。',
          'demo.ticket-driver.s2': '驱动包在内网软件库中有现成版本，下发安装并重启打印服务即可。\n\n安排在下次巡检时一并处理，不需要单独跑一趟。',
          'demo.ticket-driver.e1t': '昨天 14:20',
          'demo.ticket-driver.e1': '王芳提交工单，附设备编号。',
          'demo.ticket-driver.e2t': '昨天 15:02',
          'demo.ticket-driver.e2': '我确认内网软件库存在对应驱动包。',
          'demo.ticket-driver.e3t': '昨天 15:30',
          'demo.ticket-driver.e3': '我把它排入下次巡检。',
          'demo.ticket-quota.title': 'REQ-207 新增 5 个模型配额',
          'demo.ticket-quota.meta': '申请人 陈晨 · 优先级 P2',
          'demo.ticket-quota.time': '周一 11:05',
          'demo.ticket-quota.f1': 'REQ-207',
          'demo.ticket-quota.f2': 'P2',
          'demo.ticket-quota.f3': '平台组 张敏',
          'demo.ticket-quota.s1': '陈晨申请为新的业务评测环境新增 5 个模型配额，用于对比三个候选模型的效果。\n\n范围仅限评测工作区，不影响线上配额。',
          'demo.ticket-quota.s2': '需要管理员审批，审批通过后由平台组当天开通。\n\n评测周期预计两周，结束后释放配额。',
          'demo.ticket-quota.e1t': '周一 11:05',
          'demo.ticket-quota.e1': '陈晨提交申请。',
          'demo.ticket-quota.e2t': '周一 14:20',
          'demo.ticket-quota.e2': '我补充了评测范围与周期。',
          'demo.ticket-quota.e3t': '今天 09:10',
          'demo.ticket-quota.e3': '平台组等待管理员审批。',
        }), 'dsh-inbox: zh dictionary')

        const t = ctx.locale.bind(NS)

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
        }, InboxPage))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 20,
          locale: NS,
          label: () => t('panel'),
        }, InboxGlyph))
      },
    }
  },
})
