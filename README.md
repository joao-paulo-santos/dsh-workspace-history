# dsh-workspace-history

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH)
plugin: every compaction summary (auto-compaction or `/compact`) is
journaled into the workspace of the session that compacted, and a History
subtab reads the journal back.

    <workspace>/.dsh/history/<unix-ts>.<short-session-id>.md

- **One file per compaction**, named by the compaction's own unix
  timestamp: `ls` reads as the project's chronological timeline, and
  `ls *0a57a14f*` isolates one session. Full session id, workspace, and
  counts live in each file's header.
- **History subtab**: with [dsh-workspace-overview](https://github.com/joao-paulo-santos/dsh-workspace-overview)
  installed, a History subtab appears in the Workspace Overview tab: the
  journal listed newest first on the left, the picked entry rendered as
  markdown on the right. Entries load one at a time, on selection.
- **Per-session toggle (default on)**: "Save compaction history" lives in
  the granular Settings tab; its store is the single source of truth.
- Failure-only diagnostics land in `.dsh/history/.diag.log`.

## How to install

Requires a DeepSeek Harness checkout and a profile, here `web`. Clone the
dependencies and this plugin into a plugins folder:

```sh
mkdir -p ~/dsh-plugins && cd ~/dsh-plugins
git clone https://github.com/joao-paulo-santos/dsh-granular-settings.git
git clone https://github.com/joao-paulo-santos/dsh-workspace-overview.git
git clone https://github.com/joao-paulo-santos/dsh-workspace-history.git

# from the harness checkout
pnpm dsh plugin --profile web add ~/dsh-plugins/dsh-granular-settings
pnpm dsh plugin --profile web add ~/dsh-plugins/dsh-workspace-overview
pnpm dsh plugin --profile web add ~/dsh-plugins/dsh-workspace-history

# verify the profile still composes
pnpm dsh --profile web --dump-config
```

Restart the harness; the History subtab appears in Workspace Overview.

## Dependencies

- [dsh-granular-settings](https://github.com/joao-paulo-santos/dsh-granular-settings) hosts the "Save compaction history" session toggle (required; without it the plugin does not run, because the toggle is the only control surface)
- [dsh-workspace-overview](https://github.com/joao-paulo-santos/dsh-workspace-overview) hosts the History subtab (optional; the journal keeps writing without it, the client half simply stays inactive)
- [dsh-md-view](https://github.com/joao-paulo-santos/dsh-md-view) renders journal bodies as markdown (optional; without it bodies show as plain text)

## Plugins dependent on this

*(none)*

## Notes for plugin authors

- The `fs` service is the SandboxedFileSystem: `writeText` without a
  per-call sandbox policy is denied even inside the workspace. Every write
  here passes `{ mode: 'workspace-write', workspaceRoot: <journal dir> }`.
- `session/event` delivers the envelope `{ type, seq, time, data }`; the
  payload lives under `event.data`. Session workspace: `session.header.cwd`.
- Consuming another plugin's service is `ctx.get('granularSettings')` with
  an undefined check: degrade gracefully when it is absent (as done here).
