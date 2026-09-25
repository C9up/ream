/**
 * The profiler's own pages, and the bar injected into yours.
 *
 * Plain HTML and one inline stylesheet. A dev tool that needed a build step,
 * or pulled a framework into the page it is inspecting, would be a worse
 * neighbour than the problem it reports — and the bar lives in a shadow root
 * for the same reason: your stylesheet must not reach it, and it must not
 * reach yours.
 *
 * EVERY value that came from a request is escaped. A profiler renders the
 * URL someone asked for, the SQL a query ran and the message an error carried
 * — all attacker-reachable in exactly the case you most want to look at, and a
 * tool that turned a crafted URL into script in your own browser would be a
 * hole with a friendly face.
 */

import type { Profile, ProfileSummary } from './types.js'

/** `<`, `&` and the quotes. Everything below goes through it. */
export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

const STYLE = `
  :root { color-scheme: dark }
  body { margin: 0; background: #14161a; color: #e6e6e6;
         font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace }
  a { color: #6cb6ff; text-decoration: none }
  a:hover { text-decoration: underline }
  header { padding: 16px 20px; border-bottom: 1px solid #262a31 }
  h1 { margin: 0; font-size: 15px; font-weight: 600 }
  .meta { color: #8b949e; margin-top: 4px }
  main { padding: 20px }
  section { margin-bottom: 28px }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .08em;
       color: #8b949e; margin: 0 0 10px }
  table { width: 100%; border-collapse: collapse }
  td, th { text-align: left; padding: 6px 10px; border-bottom: 1px solid #21252c;
           vertical-align: top }
  th { color: #8b949e; font-weight: 500 }
  .num { text-align: right; white-space: nowrap; color: #8b949e }
  .sql { white-space: pre-wrap; word-break: break-word }
  .slow { color: #f0883e }
  .bad { color: #ff7b72 }
  pre { white-space: pre-wrap; word-break: break-word; margin: 0; color: #c9d1d9 }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 999px;
          background: #21262d; color: #8b949e; margin-right: 6px }
`

/** A whole page, so the profiler needs nothing served alongside it. */
function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`
}

/** The history: what a developer lands on with no token in hand. */
export function renderProfileList(profiles: readonly ProfileSummary[], missing?: string): string {
  const warning =
    missing === undefined
      ? ''
      : `<p class="bad">No profile for <code>${escapeHtml(missing)}</code> — it may have aged out.</p>`

  const rows = profiles
    .map(
      (profile) => `<tr>
      <td><a href="/__ream/profiler/${escapeHtml(profile.token)}">${escapeHtml(profile.token)}</a></td>
      <td>${escapeHtml(profile.method)}</td>
      <td class="sql">${escapeHtml(profile.url)}</td>
      <td class="${profile.status >= 500 ? 'bad' : ''}">${escapeHtml(profile.status)}</td>
      <td class="num">${escapeHtml(profile.duration.toFixed(1))} ms</td>
      <td>${Object.values(profile.badges)
        .map((badge) => `<span class="pill">${escapeHtml(badge)}</span>`)
        .join('')}</td>
    </tr>`,
    )
    .join('')

  return page(
    'Profiler',
    `<header><h1>Profiler</h1><div class="meta">${profiles.length} request${
      profiles.length === 1 ? '' : 's'
    } kept</div></header><main>${warning}
     <table><tr><th>Token</th><th>Method</th><th>URL</th><th>Status</th>
     <th class="num">Time</th><th>Collected</th></tr>${rows}</table></main>`,
  )
}

/** One request, every panel. */
export function renderProfilePage(profile: Profile, badges: Record<string, string>): string {
  const sections: string[] = []

  const exception = profile.data.exception
  if (exception !== undefined && typeof exception.message === 'string') {
    sections.push(`<section><h2 class="bad">Exception</h2>
      <p class="bad">${escapeHtml(exception.name ?? 'Error')}: ${escapeHtml(exception.message)}</p>
      ${typeof exception.stack === 'string' ? `<pre>${escapeHtml(exception.stack)}</pre>` : ''}
    </section>`)
  }

  sections.push(renderQueries(profile))

  for (const [name, data] of Object.entries(profile.data)) {
    if (name === 'database' || name === 'exception') continue
    if (Object.keys(data).length === 0) continue
    sections.push(`<section><h2>${escapeHtml(name)}</h2>
      <pre>${escapeHtml(JSON.stringify(data, null, 2))}</pre></section>`)
  }

  return page(
    `${profile.method} ${profile.url}`,
    `<header>
       <h1>${escapeHtml(profile.method)} ${escapeHtml(profile.url)}</h1>
       <div class="meta">
         ${escapeHtml(profile.status)} · ${escapeHtml(profile.duration.toFixed(1))} ms ·
         ${escapeHtml(new Date(profile.time).toISOString())} ·
         <a href="/__ream/profiler">all requests</a>
       </div>
       <div class="meta">${Object.values(badges)
         .map((badge) => `<span class="pill">${escapeHtml(badge)}</span>`)
         .join('')}</div>
     </header><main>${sections.join('')}</main>`,
  )
}

/** The panel the whole thing exists for. */
function renderQueries(profile: Profile): string {
  const database = profile.data.database
  if (database === undefined) return ''
  const queries = Array.isArray(database.queries) ? database.queries : []
  const total = typeof database.total === 'number' ? database.total : 0

  if (total === 0) return '<section><h2>Database</h2><p class="meta">No query.</p></section>'

  const rows = queries
    .map((entry) => {
      const query = asRecord(entry)
      const duration = typeof query.duration === 'number' ? query.duration : 0
      const bindings = Array.isArray(query.bindings) ? query.bindings : []
      return `<tr>
        <td class="num ${duration >= 50 ? 'slow' : ''}">${escapeHtml(duration.toFixed(2))} ms</td>
        <td class="sql">${escapeHtml(query.sql)}${
          bindings.length === 0
            ? ''
            : `<div class="meta">${escapeHtml(JSON.stringify(bindings))}</div>`
        }${
          typeof query.error === 'string' ? `<div class="bad">${escapeHtml(query.error)}</div>` : ''
        }</td>
        <td class="meta">${escapeHtml(query.model ?? '')}${
          query.inTransaction === true ? ' <span class="pill">tx</span>' : ''
        }</td>
      </tr>`
    })
    .join('')

  const capped =
    database.capped === true
      ? `<p class="meta">Listing stopped at ${queries.length}; ${escapeHtml(total)} ran.</p>`
      : ''

  return `<section><h2>Database</h2>${capped}
    <table><tr><th class="num">Time</th><th>Query</th><th>Model</th></tr>${rows}</table></section>`
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? Object.fromEntries(Object.entries(value))
    : {}
}
