/**
 * dsh-workspace-history - browser half.
 *
 * Contributes a History subtab to the Workspace Overview tab (injected
 * face: 'workspaceOverview', provided by dsh-workspace-overview). Two-pane
 * reader: the compaction journal (newest first) on the left, the picked
 * entry rendered as markdown on the right.
 *
 * Optional UI: when dsh-workspace-overview is absent this bundle stays
 * pending (unmet inject) and the host half keeps journaling unchanged.
 */
window.__ModuleLoader__.load({ id: 'dsh-workspace-history', factory: (require) => {
  var module = { exports: {} }; var exports = module.exports;
  const React = require('react')

  let overviewService = undefined   // workspaceOverview (set in apply)
  let mdServiceResolver = () => undefined   // optional dsh-md-view (set in apply)

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const pad = (n) => String(n).padStart(2, '0')
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  const dayLabelOf = (d, now) => {
    if (sameDay(d, now)) return 'Today'
    if (sameDay(d, new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))) return 'Yesterday'
    const m = MONTHS[d.getMonth()] + ' ' + d.getDate()
    return d.getFullYear() === now.getFullYear() ? m : m + ', ' + d.getFullYear()
  }
  const clockOf = (d) => pad(d.getHours()) + ':' + pad(d.getMinutes())

  // "Compaction 1787919810 — 2026-08-28 13:23:30" -> "2026-08-28 13:23:30"
  const titleOf = (raw) => {
    const m = /^Compaction\s+\d+\s+[—-]\s+(.*)$/.exec(raw.trim())
    return m !== null ? m[1] : raw.trim()
  }

  // Split one journal file into { title, meta, blocks } — the writer's shape
  // is: "# title", blank, "- key: value" lines, blank, markdown body.
  const parseEntry = (text) => {
    const lines = text.split('\n')
    let i = 0
    let title
    while (i < lines.length && lines[i].trim() === '') i++
    if (i < lines.length && lines[i].startsWith('# ')) { title = titleOf(lines[i].slice(2)); i++ }
    const meta = []
    if (title !== undefined) {
      while (i < lines.length && lines[i].trim() === '') i++   // writer puts a blank line after the title
      while (i < lines.length) {
        const t = lines[i].trim()
        if (t === '') { i++; break }                           // and one after the meta block
        if (t.startsWith('- ') && t.includes(':')) {
          const cut = t.indexOf(':')
          meta.push({ k: t.slice(2, cut).trim(), v: t.slice(cut + 1).trim() })
          i++
        } else break
      }
    }
    while (i < lines.length && lines[i].trim() === '') i++
    return { title, meta, body: lines.slice(i).join('\n') }
  }

  // Body rendering delegates to dsh-md-view when installed; without it the
  // journal body shows as plain preformatted text (still fully readable).
  const renderBodyOf = (body) => {
    const mdView = mdServiceResolver()
    if (mdView === undefined) {
      return React.createElement('pre', { className: 'whh-rawpre' }, body)
    }
    return React.createElement('div', { className: 'mdv whh-doc' },
      mdView.render(body))
  }

  const HistoryTab = (props) => {
    const workspaceId = props.useWorkspaces((st) => st.recentWorkspaceId)
    const workspacePath = props.useWorkspaces((st) => {
      const w = st.items.find((item) => item.workspaceId === workspaceId)
      return w !== undefined ? w.path : undefined
    })
    const [entries, setEntries] = React.useState(undefined)   // undefined = loading
    const [selected, setSelected] = React.useState(undefined) // file name
    const [text, setText] = React.useState(undefined)         // picked entry body
    const [readError, setReadError] = React.useState(undefined)
    const [listError, setListError] = React.useState(undefined)

    React.useEffect(() => {
      setSelected(undefined); setText(undefined); setReadError(undefined); setListError(undefined)
      if (typeof workspacePath !== 'string' || workspacePath === '') { setEntries(undefined); return }
      let live = true
      fetch('/workspace-history/list?path=' + encodeURIComponent(workspacePath))
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error('list failed'))))
        .then((body) => {
          if (!live) return
          const list = Array.isArray(body.entries) ? body.entries : []
          setEntries(list)
          if (list.length > 0) open(list[0])   // land on the newest entry
        }, () => { if (live) { setEntries([]); setListError('Could not read the history journal.') } })
      return () => { live = false }
    }, [workspacePath])

    const open = (entry) => {
      setSelected(entry.file)
      setText(undefined)
      setReadError(undefined)
      fetch('/workspace-history/entry?path=' + encodeURIComponent(workspacePath)
        + '&file=' + encodeURIComponent(entry.file))
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error('load failed'))))
        .then((body) => { setText(String(body.text !== undefined ? body.text : '')) },
          () => { setReadError('Could not load this entry.') })
    }

    if (typeof workspacePath !== 'string' || workspacePath === '') {
      return React.createElement('p', { className: 'whh-empty' }, 'No workspace context.')
    }
    if (entries === undefined) {
      return React.createElement('p', { className: 'whh-empty' }, 'Loading…')
    }

    const now = new Date()
    const picked = entries.find((entry) => entry.file === selected)
    const side = React.createElement('div', { className: 'whh-side' },
      React.createElement('div', { className: 'whh-side-head' },
        'Compactions' + (entries.length > 0 ? ' (' + entries.length + ')' : '')),
      listError !== undefined ? React.createElement('p', { className: 'whh-error' }, listError) : null,
      entries.length === 0
        ? React.createElement('p', { className: 'whh-empty' },
            'Nothing yet. Entries appear here when a session compacts (auto or /compact).')
        : React.createElement('div', { className: 'whh-list' },
            entries.map((entry) => {
              const d = new Date(entry.ts * 1000)
              return React.createElement('button', {
                key: entry.file,
                type: 'button',
                className: 'whh-row' + (selected === entry.file ? ' whh-row-on' : ''),
                onClick: () => { open(entry) },
              },
              React.createElement('span', { className: 'whh-row-when' },
                dayLabelOf(d, now) + ' ' + clockOf(d)),
              React.createElement('span', { className: 'whh-row-sub' }, entry.session))
            })))

    let reader
    if (picked === undefined) {
      reader = React.createElement('p', { className: 'whh-empty' }, 'Select an entry to read it.')
    } else if (readError !== undefined) {
      reader = React.createElement('p', { className: 'whh-error' }, readError)
    } else if (text === undefined) {
      reader = React.createElement('p', { className: 'whh-empty' }, 'Loading…')
    } else {
      const parsed = parseEntry(text)
      const metaValueOf = (v) => /^session-.{20,}/.test(v) ? 'session-' + v.slice(8, 16) : v
      reader = React.createElement(React.Fragment, null,
        React.createElement('h2', { className: 'whh-title' },
          parsed.title !== undefined && parsed.title !== '' ? parsed.title : 'Compaction'),
        parsed.meta.length > 0 ? React.createElement('p', { className: 'whh-meta' },
          parsed.meta.map((m, i) => React.createElement(React.Fragment, { key: m.k + i },
            i > 0 ? React.createElement('span', { className: 'whh-meta-sep' }, '·') : null,
            React.createElement('span', { className: 'whh-meta-k' }, m.k),
            ' ',
            metaValueOf(m.v)))) : null,
        renderBodyOf(parsed.body))
    }

    return React.createElement('div', { className: 'whh-page' }, side,
      React.createElement('div', { className: 'whh-reader' }, reader))
  }

  module.exports = {
    name: 'workspace-history-client',
    inject: ['workspaceOverview'],
    apply(ctx) {
      overviewService = ctx.workspaceOverview
      mdServiceResolver = () => { try { return ctx.get('mdView') } catch (e) { return undefined } }
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-workspace-history'
      tag.textContent = '.whh-page{flex:1 1 auto;min-height:0;display:flex;gap:20px;width:100%;color:var(--dsw-alias-label-primary)}'
        + '.whh-side{flex:none;width:250px;min-height:0;display:flex;flex-direction:column;gap:8px}'
        + '.whh-side-head{font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;opacity:.55;padding:0 10px}'
        + '.whh-list{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:2px;padding-right:2px}'
        + '.whh-row{font:inherit;text-align:left;cursor:pointer;padding:8px 10px;border:none;border-radius:8px;background:transparent;color:inherit;display:flex;flex-direction:column;gap:2px}'
        + '.whh-row:hover{background:var(--dsw-alias-bg-layer-2)}'
        + '.whh-row-on{background:var(--dsw-alias-bg-layer-2);box-shadow:inset 2px 0 0 #3b82f6}'
        + '.whh-row-when{font-size:12.5px}'
        + '.whh-row-sub{font-size:11px;font-family:ui-monospace,monospace;opacity:.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
        + '.whh-reader{flex:1;min-width:0;overflow-y:auto;padding-right:4px}'
        + '.whh-title{margin:0;font-size:15px;font-weight:650}'
        + '.whh-meta{margin:8px 0 0;font-size:12px;opacity:.65;word-break:break-word;display:flex;flex-wrap:wrap;column-gap:6px}'
        + '.whh-meta-sep{opacity:.5}'
        + '.whh-meta-k{font-weight:600}'
                                                                                + '.whh-doc{margin-top:18px;max-width:none}'
        + '.whh-rawpre{margin:18px 0 0;padding:12px;font-size:12px;font-family:ui-monospace,monospace;line-height:1.55;white-space:pre-wrap;word-break:break-word;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-label-tertiary);border-radius:8px;overflow:auto}'
        + '.whh-empty{margin:0;font-size:13px;opacity:.65}'
        + '.whh-error{margin:0;font-size:12.5px;color:#ef4444}'
      document.head.appendChild(tag)

      const offTab = overviewService.registerTab({ id: 'history', label: 'History', order: 20 }, HistoryTab)

      return () => {
        try { offTab() } catch (e) {}
        try { tag.remove() } catch (e) {}
      }
    },
  }
  return module.exports
} })
