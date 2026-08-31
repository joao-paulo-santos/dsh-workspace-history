/**
 * dsh-workspace-history — host half.
 *
 * On every `compaction/summary` session event (auto-compaction or /compact),
 * in ANY session of the process, writes one file:
 *   <session workspace>/.dsh/history/<unix-ts>.<short-session-id>.md
 *
 * Per-session opt-out (default ON) lives in the granular Settings tab:
 * dsh-granular-settings is a HARD dependency (the `granularSettings`
 * service inject below). The fiber waits for the service before
 * activating — no boot-order race (guide 08 Case 15), and the plugin
 * simply does not run where the settings plugin is absent, because the tab
 * is the ONLY control surface (the v0.1 command, v0.2 routes/pill, and the
 * v0.3 .optout.json fallback are all gone).
 *
 * Reading surface for the Workspace Overview tab (dsh-workspace-overview):
 *   GET /workspace-history/list?path=<workspace>
 *     -> { entries: [{ file, ts, session }] }   newest first
 *   GET /workspace-history/entry?path=<workspace>&file=<name>
 *     -> { file, text }
 * Both validate `file` against the journal's own name shape (no paths).
 *
 * Engineering notes carried over from the dynamic-plugin prototype:
 * - fs is the SandboxedFileSystem: writeText WITHOUT a per-call policy falls
 *   back to the deployment policy and is denied (FS_SANDBOX_DENIED) even
 *   inside the workspace. Every write below passes a grant scoped to exactly
 *   the journal directory.
 * - session/event delivers the ENVELOPE { type, seq, time, data }; the
 *   compaction payload lives under event.data.
 * - The live Session keeps creation metadata on session.header (header.cwd).
 */

export const name = 'workspace-history'

export const inject = ['fs', 'sessions', 'granularSettings', 'webServer']

const SETTING_KEY = 'save-history'

const pad = (n) => String(n).padStart(2, '0')
const dateOf = (t) => t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate())
const clockOf = (t) => pad(t.getHours()) + ':' + pad(t.getMinutes()) + ':' + pad(t.getSeconds())
const msg = (error) => (error && error.message ? error.message : String(error))
const shortIdOf = (sid) => (typeof sid === 'string' && sid !== '' ? sid.replace(/^session-/, '').slice(0, 8) : 'unknown')
const journalDirOf = (cwd) => {
  if (typeof cwd !== 'string' || cwd === '') return undefined
  const base = cwd.length > 1 && cwd.endsWith('/') ? cwd.slice(0, -1) : cwd
  return base + '/.dsh/history'
}

export function apply(ctx) {
  const fs = ctx.fs
  const sessions = ctx.sessions
  const webServer = ctx.webServer

  let tail = Promise.resolve()                    // serialize ALL writes: no interleaving

  // ---- failure-only diagnostics + canary ----
  const note = (dir, line) => {
    tail = tail.then(async () => {
      try {
        if (dir === undefined) return
        const target = await fs.resolve(dir + '/.diag.log')
        let prev = ''
        try { prev = await fs.readText(target) } catch (e) { prev = '' }
        await fs.writeText(target, prev + '[' + clockOf(new Date()) + '] ' + line + '\n',
          undefined, undefined, { mode: 'workspace-write', workspaceRoot: dir })
      } catch (error) {
        console.error('workspace-history: diag write failed', msg(error))
      }
    })
  }

  // ---- the toggle: one registration, one store (the Settings tab) ----
  const setting = ctx.granularSettings.register({
    namespace: 'workspace-history',
    owner: 'Workspace History',
    scope: 'session',
    key: SETTING_KEY,
    type: 'toggle',
    label: 'Save compaction history',
    description: 'Write every compaction summary to <workspace>/.dsh/history/<ts>.<session>.md',
    defaultValue: true,
  })
  const disposers = [() => { try { setting.dispose() } catch (e) {} }]

  // The journal's one question: is history enabled for this session?
  const isEnabled = async (sid) => {
    try { return await setting.get(sid) === true } catch (e) { return true }
  }

  // ---- the journal ----
  disposers.push(ctx.on('session/event', (session, event) => {
    try {
      if (event === null || event === undefined || event.type !== 'compaction/summary') return
      const payload = (event.data && typeof event.data === 'object') ? event.data : event

      const blocks = Array.isArray(payload.summary) ? payload.summary : []
      const parts = []
      for (const b of blocks) {
        if (b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
      }
      const body = parts.join('\n').trim()
      const sid = session && typeof session.id === 'string' ? session.id : 'unknown'
      const cwd = session && session.header && typeof session.header.cwd === 'string'
        ? session.header.cwd : undefined
      const dir = journalDirOf(cwd)
      if (body === '') {
        note(dir, 'compaction/summary with empty body ignored (envelope keys: '
          + Object.keys(event).join(',') + '; payload keys: ' + Object.keys(payload).join(',') + ')')
        return
      }
      if (dir === undefined) {
        console.error('workspace-history: compaction for session ' + shortIdOf(sid) + ' has no resolvable workspace; not journaled')
        return
      }

      const job = async () => {
        if (await isEnabled(sid) !== true) {
          note(dir, 'journal SKIPPED (history disabled for session ' + shortIdOf(sid) + ')')
          return
        }
        const when = typeof event.time === 'number' ? new Date(event.time) : new Date()
        const ts = Math.floor(when.getTime() / 1000)
        const short = shortIdOf(sid)
        const shadowed = Array.isArray(payload.shadowedSeqs) ? payload.shadowedSeqs.length : 0
        const tokenNote = typeof payload.shadowedTokenCount === 'number'
          ? ' (~' + Math.max(1, Math.round(payload.shadowedTokenCount / 1000)) + 'k tokens)'
          : ''
        const modelNote = typeof payload.model === 'string' ? '; summary by ' + payload.model : ''
        const content = [
          '# Compaction ' + ts + '. ' + dateOf(when) + ' ' + clockOf(when),
          '',
          '- session: ' + sid,
          '- workspace: ' + cwd,
          '- compacted: ' + shadowed + ' events' + tokenNote + modelNote,
          '',
          body,
          '',
        ].join('\n')
        let name = ts + '.' + short + '.md'
        for (let attempt = 2; ; attempt++) {
          const target = await fs.resolve(dir + '/' + name)
          let prev = ''
          try { prev = await fs.readText(target) } catch (e) { prev = '' }
          if (prev === '') {
            await fs.writeText(target, content, undefined, undefined,
              { mode: 'workspace-write', workspaceRoot: dir })
            note(dir, 'journal write OK -> ' + name + ' (' + shadowed + ' events shadowed)')
            return
          }
          name = ts + '.' + short + '-' + attempt + '.md'
        }
      }
      tail = tail.then(job).catch((error) => { note(dir, 'journal write FAILED: ' + msg(error)) })
    } catch (error) {
      console.error('workspace-history: listener error', msg(error))
    }
  }))

  // ---- read surface for the Workspace Overview History subtab ----
  const FILE_RE = /^\d{10}(\.\d+)?\.[0-9a-f-]{1,16}(-\d+)?\.md$/
  const sendJson = (res, status, body) => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(body))
  }
  const entryTsOf = (file) => {
    const n = parseInt(file.split('.')[0], 10)
    return Number.isFinite(n) ? n : 0
  }

  disposers.push(webServer.register({
    kind: 'exact',
    path: '/workspace-history/list',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost')
        const path = url.searchParams.get('path')
        if (typeof path !== 'string' || path === '') throw new Error('path required')
        const dir = journalDirOf(path)
        let names = []
        try {
          const entries = await fs.listDir(await fs.resolve(dir))
          for (const entry of entries) {
            if (entry === null || typeof entry !== 'object') continue
            if (entry.type !== undefined && entry.type !== 'file') continue
            if (typeof entry.name === 'string' && FILE_RE.test(entry.name)) names.push(entry.name)
          }
        } catch (e) { names = [] }   // absent journal dir: empty history
        names.sort((a, b) => entryTsOf(b) - entryTsOf(a))
        sendJson(res, 200, {
          entries: names.map((file) => ({ file, ts: entryTsOf(file), session: file.split('.')[1] || '' })),
        })
      } catch (error) { sendJson(res, 400, { error: msg(error) }) }
    },
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: '/workspace-history/entry',
    handler: async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost')
        const path = url.searchParams.get('path')
        const file = url.searchParams.get('file')
        if (typeof path !== 'string' || path === '') throw new Error('path required')
        if (typeof file !== 'string' || !FILE_RE.test(file)) throw new Error('bad file name')
        const dir = journalDirOf(path)
        const text = await fs.readText(await fs.resolve(dir + '/' + file))
        sendJson(res, 200, { file, text })
      } catch (error) { sendJson(res, 400, { error: msg(error) }) }
    },
  }))

  return () => { for (const d of disposers) { try { d() } catch (e) {} } }
}
