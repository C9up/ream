/*
 * The debug toolbar, as it runs in the browser.
 *
 * Served from /__ream/profiler/_assets/toolbar.js and loaded by a <script src>
 * that carries the request's profile token in data attributes: no inline code,
 * so a `script-src 'self'` policy runs it, and a nonce-only one runs it through
 * the nonce the server stamps on the tag.
 *
 * Built with the DOM API and `textContent` only. Everything it shows came from
 * a request — a URL, SQL, a log message — and none of it is ever parsed as
 * markup.
 *
 * Plain readable JS, on purpose: someone will open the inspector and land
 * here.
 */
;(() => {
  const script = document.currentScript
  if (!script || window.__reamProfiler) return
  const base = script.dataset.path || '/__ream/profiler'
  const pageToken = script.dataset.token || ''
  const nonce = script.nonce || script.getAttribute('nonce') || ''
  const TOKEN = /^[A-Za-z0-9_-]{1,64}$/
  const STORE = 'ream/profiler/toolbar'
  const BAR = 34

  // ── State ───────────────────────────────────────────────

  const saved = read()
  const state = {
    closed: saved.closed === true,
    open: saved.open === true,
    tab: typeof saved.tab === 'string' ? saved.tab : 'request',
    height: clampHeight(typeof saved.height === 'number' ? saved.height : 320),
    /** Every request this page knows: itself first, then each fetch/XHR. */
    requests: [],
    /** The one the bar shows. */
    current: null,
    filters: {
      query: '',
      onlyDuplicates: false,
      sortBySlowest: false,
      levels: {},
      logText: '',
      eventText: '',
    },
  }
  window.__reamProfiler = { state }

  function read() {
    try {
      const value = JSON.parse(localStorage.getItem(STORE) || '{}')
      return value && typeof value === 'object' ? value : {}
    } catch {
      return {}
    }
  }

  function persist() {
    try {
      localStorage.setItem(
        STORE,
        JSON.stringify({
          closed: state.closed,
          open: state.open,
          tab: state.tab,
          height: state.height,
        }),
      )
    } catch {
      // Private mode or storage disabled: the bar still works, it just forgets.
    }
  }

  function clampHeight(value) {
    const max = Math.max(160, window.innerHeight - BAR - 60)
    return Math.min(Math.max(value, 120), max)
  }

  // ── Requests made by the page after it loaded ───────────

  function track(entry) {
    state.requests.push(entry)
    if (state.requests.length > 100) state.requests.splice(1, 1)
    if (entry.token) load(entry)
    else render()
  }

  function own(url) {
    try {
      return new URL(url, location.href).pathname.startsWith(base)
    } catch {
      return false
    }
  }

  const originalFetch = window.fetch
  if (typeof originalFetch === 'function') {
    window.fetch = function (...args) {
      const [input, init] = args
      const url = typeof input === 'string' ? input : input?.url || String(input)
      const method = (init?.method || input?.method || 'GET').toUpperCase()
      const started = performance.now()
      const promise = originalFetch.apply(this, args)
      if (own(url)) return promise
      promise.then(
        (response) =>
          track({
            kind: 'fetch',
            method,
            url,
            status: response.status,
            duration: performance.now() - started,
            token: response.headers.get('x-debug-token') || '',
          }),
        () =>
          track({
            kind: 'fetch',
            method,
            url,
            status: 0,
            duration: performance.now() - started,
            token: '',
          }),
      )
      return promise
    }
  }

  const xhrOpen = XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.open = function (...args) {
    const [method, url] = args
    if (!own(String(url))) {
      const started = performance.now()
      this.addEventListener('loadend', () => {
        // Only read a header the response actually exposes: asking for one it
        // does not prints "Refused to get unsafe header" in the console.
        const has = /^x-debug-token:/im.test(this.getAllResponseHeaders())
        track({
          kind: 'xhr',
          method: String(method).toUpperCase(),
          url: String(url),
          status: this.status,
          duration: performance.now() - started,
          token: has ? this.getResponseHeader('x-debug-token') || '' : '',
        })
      })
    }
    return xhrOpen.apply(this, args)
  }

  /** Fetch one profile; the server may still be saving it, so retry a little. */
  function load(entry, attempt = 0) {
    if (!TOKEN.test(entry.token)) return render()
    originalFetch
      .call(window, `${base}/${entry.token}.json`, { headers: { accept: 'application/json' } })
      .then((response) => {
        if (response.status === 404 && attempt < 5) {
          setTimeout(() => load(entry, attempt + 1), 120 * (attempt + 1))
          return null
        }
        return response.ok ? response.json() : null
      })
      .then((profile) => {
        if (profile) {
          entry.profile = profile
          entry.status = profile.status
          // The page's own load is timed by the server, not by an interceptor.
          if (entry.kind === 'page') entry.duration = profile.duration
          if (state.current === null && entry.kind === 'page') state.current = entry
        }
        render()
      })
      .catch(() => render())
  }

  // ── DOM helpers ─────────────────────────────────────────

  function h(tag, props, ...children) {
    const node = document.createElement(tag)
    for (const [key, value] of Object.entries(props || {})) {
      if (value === undefined || value === null || value === false) continue
      if (key === 'text') node.textContent = String(value)
      else if (key === 'class') node.className = value
      // Through the CSSOM: a `style` attribute is inline style, which a
      // `style-src` policy without 'unsafe-inline' silently drops.
      else if (key === 'style') node.style.cssText = value
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value)
      else if (key === 'dataset') Object.assign(node.dataset, value)
      else node.setAttribute(key, value === true ? '' : String(value))
    }
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue
      node.append(child instanceof Node ? child : document.createTextNode(String(child)))
    }
    return node
  }

  function ms(value) {
    const n = Number(value) || 0
    if (n < 1) return `${n.toFixed(2)} ms`
    if (n < 100) return `${n.toFixed(1)} ms`
    return `${Math.round(n)} ms`
  }

  function mb(value) {
    return `${(Number(value) || 0).toFixed(1)} MB`
  }

  function json(value) {
    try {
      return JSON.stringify(value, null, 2)
    } catch {
      return String(value)
    }
  }

  function statusTone(status) {
    if (!status || status >= 500) return 'bad'
    if (status >= 400) return 'warn'
    if (status >= 300) return 'warn'
    return 'ok'
  }

  function row(label, value) {
    if (value === undefined || value === null || value === '') return null
    return h('div', { class: 'row' }, h('b', { text: label }), h('span', { text: String(value) }))
  }

  function copy(text, button) {
    const done = () => {
      button.textContent = 'copied'
      setTimeout(() => {
        button.textContent = 'copy'
      }, 1500)
    }
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, () => {})
  }

  // ── What each panel derives from a profile ──────────────

  function panelOf(profile, name) {
    const value = profile?.data?.[name]
    return value && typeof value === 'object' ? value : {}
  }

  function queriesOf(profile) {
    const db = panelOf(profile, 'database')
    const queries = Array.isArray(db.queries) ? db.queries : []
    const counts = new Map()
    for (const query of queries) {
      const key = `${query.sql}\u0000${JSON.stringify(query.bindings)}\u0000${query.connection || ''}`
      query.key = key
      counts.set(key, (counts.get(key) || 0) + 1)
    }
    let duplicates = 0
    for (const query of queries) {
      query.copies = counts.get(query.key) || 1
      if (query.copies > 1) duplicates += 1
    }
    return {
      total: Number(db.total) || 0,
      failed: Number(db.failed) || 0,
      duration: Number(db.duration) || 0,
      capped: db.capped === true,
      queries,
      duplicates,
      unique: counts.size,
      slowest: queries.reduce((max, query) => Math.max(max, Number(query.duration) || 0), 0),
    }
  }

  function eventsOf(profile) {
    const panel = panelOf(profile, 'events')
    return Array.isArray(panel.events) ? panel.events : []
  }

  function cacheOf(profile) {
    const ops = eventsOf(profile).filter((event) => event.name.startsWith('cache:'))
    const count = (suffix) => ops.filter((event) => event.name === `cache:${suffix}`).length
    return { ops, hits: count('hit'), misses: count('miss'), writes: count('written') }
  }

  function mailsOf(profile) {
    return eventsOf(profile).filter((event) => /^mail[:.]/.test(event.name))
  }

  function logsOf(profile) {
    const panel = panelOf(profile, 'logs')
    return {
      total: Number(panel.total) || 0,
      errors: Number(panel.errors) || 0,
      warnings: Number(panel.warnings) || 0,
      lines: Array.isArray(panel.lines) ? panel.lines : [],
    }
  }

  // ── The shell ───────────────────────────────────────────

  const host = h('div', { 'data-ream-profiler': '' })
  host.style.cssText = 'all:initial'
  const root = host.attachShadow({ mode: 'open' })
  root.append(
    h('link', {
      rel: 'stylesheet',
      href: `${base}/_assets/toolbar.css`,
      nonce: nonce || undefined,
    }),
  )
  const shell = h('div', { class: 'rp', role: 'region', 'aria-label': 'Debug toolbar' })
  const panel = h('div', { class: 'panel' })
  const grip = h('div', { class: 'grip', title: 'Drag to resize' })
  const tabs = h('nav', { class: 'tabs' })
  const body = h('div', { class: 'body' })
  const bar = h('div', { class: 'bar', role: 'toolbar' })
  const restore = h('button', {
    class: 'restore',
    text: 'R',
    title: 'Show the debug toolbar',
    onclick: () => {
      state.closed = false
      persist()
      render()
    },
  })
  panel.append(grip, tabs, body)
  shell.append(panel, bar, restore)
  root.append(shell)

  // ── Keeping the page visible ────────────────────────────

  // The page keeps its own bottom padding; the bar adds its height to it, so
  // nothing at the bottom of the page ends up underneath.
  let originalPadding = null
  function offsetPage() {
    if (!document.body) return
    if (originalPadding === null) {
      originalPadding = Number.parseFloat(getComputedStyle(document.body).paddingBottom) || 0
    }
    const covered = state.closed ? 0 : shell.getBoundingClientRect().height
    document.body.style.paddingBottom = covered > 0 ? `${originalPadding + covered}px` : ''
  }

  // ── Resizing ────────────────────────────────────────────

  grip.addEventListener('mousedown', (start) => {
    start.preventDefault()
    const startY = start.clientY
    const startHeight = state.height
    const move = (event) => {
      state.height = clampHeight(startHeight + (startY - event.clientY))
      panel.style.height = `${state.height}px`
      offsetPage()
    }
    const up = () => {
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
      persist()
    }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
  })

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.open) {
      state.open = false
      persist()
      render()
    }
  })

  function openTab(name) {
    if (state.open && state.tab === name) state.open = false
    else {
      state.open = true
      state.tab = name
    }
    persist()
    render()
  }

  // ── The bar ─────────────────────────────────────────────

  function item(opts) {
    return h(
      'div',
      {
        class: 'item',
        tabindex: '0',
        role: 'button',
        dataset: {
          tone: opts.tone || '',
          ...(state.open && state.tab === opts.tab ? { active: '' } : {}),
        },
        onclick: () => opts.tab && openTab(opts.tab),
        onkeydown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            if (opts.tab) openTab(opts.tab)
          }
        },
      },
      opts.lead || null,
      opts.label ? h('span', { class: 'label', text: opts.label }) : null,
      h('span', { class: 'value', text: opts.value }),
      opts.info
        ? h('div', { class: 'info', onclick: (event) => event.stopPropagation() }, opts.info)
        : null,
    )
  }

  function renderBar(profile, entry) {
    const items = []
    const request = panelOf(profile, 'request')
    const status = Number(profile.status) || 0
    items.push(
      item({
        tab: 'request',
        lead: h('span', {
          class: 'status',
          dataset: { tone: statusTone(status) },
          text: String(status),
        }),
        value: `${profile.method} ${request.route || request.path || profile.url}`,
        info: [
          row('Status', status),
          row('Method', profile.method),
          row('URL', profile.url),
          row('Route', request.route),
          row('Pattern', request.pattern),
          row('Controller', request.controller),
          row('User', request.userId),
          row('Session', request.session ? 'yes' : 'no'),
          row('Content type', request.response?.contentType),
        ],
      }),
    )

    const duration = Number(profile.duration) || 0
    const q = queriesOf(profile)
    items.push(
      item({
        tab: 'timeline',
        label: 'time',
        value: ms(duration),
        tone: duration > 1000 ? 'warn' : '',
        info: [
          row('Total time', ms(duration)),
          row(
            'In SQL',
            `${ms(q.duration)} (${duration > 0 ? Math.round((q.duration / duration) * 100) : 0}%)`,
          ),
          row('Profile', profile.token),
        ],
      }),
    )

    const memory = panelOf(profile, 'memory')
    items.push(
      item({
        tab: 'timeline',
        label: 'mem',
        value: mb(memory.usedMb),
        tone: memory.usedMb > 512 ? 'warn' : '',
        info: [
          row('Heap used', mb(memory.usedMb)),
          row('Heap total', mb(memory.totalMb)),
          row('Resident', mb(memory.rssMb)),
          row('During request', `${memory.deltaMb >= 0 ? '+' : ''}${mb(memory.deltaMb)}`),
        ],
      }),
    )

    items.push(
      item({
        tab: 'queries',
        label: 'db',
        value: `${q.total} · ${ms(q.duration)}`,
        tone: q.failed > 0 ? 'bad' : q.duplicates > 0 || q.total >= 50 ? 'warn' : '',
        info: [
          row('Statements', q.total),
          row('Duplicated', q.duplicates > 0 ? `${q.duplicates} (${q.unique} unique)` : 'none'),
          row('Failed', q.failed || 'none'),
          row('Total time', ms(q.duration)),
          row('Slowest', q.total > 0 ? ms(q.slowest) : ''),
        ],
      }),
    )

    const logs = logsOf(profile)
    if (logs.total > 0) {
      items.push(
        item({
          tab: 'logs',
          label: 'logs',
          value: String(logs.errors || logs.warnings || logs.total),
          tone: logs.errors > 0 ? 'bad' : logs.warnings > 0 ? 'warn' : '',
          info: [
            row('Errors', logs.errors),
            row('Warnings', logs.warnings),
            row('Lines', logs.total),
          ],
        }),
      )
    }

    const events = eventsOf(profile)
    if (events.length > 0) {
      const names = new Map()
      for (const event of events) names.set(event.name, (names.get(event.name) || 0) + 1)
      items.push(
        item({
          tab: 'events',
          label: 'events',
          value: String(panelOf(profile, 'events').total || events.length),
          info: [...names.entries()].slice(0, 12).map(([name, count]) => row(name, `× ${count}`)),
        }),
      )
    }

    const cache = cacheOf(profile)
    if (cache.ops.length > 0) {
      const reads = cache.hits + cache.misses
      items.push(
        item({
          tab: 'cache',
          label: 'cache',
          value: String(cache.ops.length),
          info: [
            row('Operations', cache.ops.length),
            row(
              'Hits',
              reads > 0
                ? `${cache.hits} / ${reads} (${Math.round((cache.hits / reads) * 100)}%)`
                : 0,
            ),
            row('Misses', cache.misses),
            row('Writes', cache.writes),
          ],
        }),
      )
    }

    const mails = mailsOf(profile)
    if (mails.length > 0) {
      items.push(item({ tab: 'mail', label: 'mail', value: String(mails.length) }))
    }

    const exception = panelOf(profile, 'exception')
    if (typeof exception.message === 'string') {
      items.push(
        item({
          tab: 'exception',
          tone: 'bad',
          value: `${exception.name || 'Error'}`,
          info: [row('Message', exception.message), row('Code', exception.code)],
        }),
      )
    }

    const ajax = state.requests.filter((r) => r.kind !== 'page')
    if (ajax.length > 0) {
      const failed = ajax.slice(-4).some((r) => !r.status || r.status >= 400)
      items.push(
        item({
          tab: 'ajax',
          label: 'ajax',
          value: String(ajax.length),
          tone: failed ? 'bad' : '',
          info: ajax
            .slice(-8)
            .reverse()
            .map((r) => row(`${r.method} ${r.status || '—'}`, `${r.url} · ${ms(r.duration)}`)),
        }),
      )
    }

    const spacer = h('div', { class: 'spacer' }, profile.url || '')
    if (entry && entry.kind !== 'page') {
      spacer.append(
        h('button', {
          class: 'viewing',
          text: `viewing ${entry.kind} · back to page`,
          onclick: () => {
            state.current = state.requests[0] || null
            render()
          },
        }),
      )
    }

    const app = panelOf(profile, 'app')
    const appItem = item({
      tab: 'app',
      value: app.ream ? `ream ${app.ream}` : 'ream',
      info: [
        row('ream', app.ream),
        row('Node.js', app.node),
        row('Environment', app.environment),
        row('Platform', app.platform),
        row('Process', app.pid),
        row('Uptime', app.uptime !== undefined ? `${app.uptime} s` : ''),
      ],
    })

    const full = h('a', {
      class: 'tool',
      href: TOKEN.test(profile.token) ? `${base}/${profile.token}` : base,
      target: '_blank',
      rel: 'noopener',
      title: 'Open the full profile',
      text: '↗',
    })
    const toggle = h('button', {
      class: 'tool',
      title: state.open ? 'Collapse the panel' : 'Expand the panel',
      text: state.open ? '▾' : '▴',
      onclick: () => openTab(state.tab),
    })
    const close = h('button', {
      class: 'tool',
      title: 'Hide the toolbar',
      text: '✕',
      onclick: () => {
        state.closed = true
        state.open = false
        persist()
        render()
      },
    })

    bar.replaceChildren(...items, spacer, appItem, full, toggle, close)
  }

  // ── The panel ───────────────────────────────────────────

  const TABS = [
    { name: 'request', label: 'Request' },
    { name: 'queries', label: 'Queries', count: (p) => queriesOf(p).total, tone: (p) => dbTone(p) },
    { name: 'logs', label: 'Logs', count: (p) => logsOf(p).total, tone: (p) => logTone(p) },
    { name: 'events', label: 'Events', count: (p) => eventsOf(p).length },
    { name: 'timeline', label: 'Timeline' },
    { name: 'cache', label: 'Cache', count: (p) => cacheOf(p).ops.length, hideEmpty: true },
    { name: 'mail', label: 'Mail', count: (p) => mailsOf(p).length, hideEmpty: true },
    {
      name: 'exception',
      label: 'Exception',
      count: (p) => (typeof panelOf(p, 'exception').message === 'string' ? 1 : 0),
      tone: () => 'bad',
      hideEmpty: true,
    },
    { name: 'ajax', label: 'AJAX', count: () => state.requests.length - 1, hideEmpty: true },
    { name: 'app', label: 'App' },
  ]

  function dbTone(profile) {
    const q = queriesOf(profile)
    return q.failed > 0 ? 'bad' : q.duplicates > 0 ? 'warn' : ''
  }

  function logTone(profile) {
    const logs = logsOf(profile)
    return logs.errors > 0 ? 'bad' : logs.warnings > 0 ? 'warn' : ''
  }

  function renderPanel(profile) {
    panel.style.height = `${state.height}px`
    const visible = TABS.filter((tab) => !tab.hideEmpty || (tab.count?.(profile) || 0) > 0)
    if (!visible.some((tab) => tab.name === state.tab)) state.tab = 'request'
    tabs.replaceChildren(
      ...visible.map((tab) => {
        const count = tab.count ? tab.count(profile) : undefined
        return h(
          'button',
          {
            class: 'tab',
            dataset: state.tab === tab.name ? { active: '' } : {},
            onclick: () => {
              state.tab = tab.name
              persist()
              render()
            },
          },
          tab.label,
          count
            ? h('span', {
                class: 'count',
                dataset: { tone: tab.tone?.(profile) || '' },
                text: count,
              })
            : null,
        )
      }),
    )
    const view = VIEWS[state.tab] || VIEWS.request
    // replaceChildren would print a null as the text "null".
    body.replaceChildren(
      ...[view(profile)].flat(Infinity).filter((node) => node !== null && node !== undefined),
    )
  }

  function table(rows) {
    const present = rows.filter(
      ([, value]) => value !== undefined && value !== null && value !== '',
    )
    if (present.length === 0) return h('div', { class: 'empty', text: 'Nothing.' })
    return h(
      'table',
      null,
      present.map(([key, value]) =>
        h(
          'tr',
          null,
          h('td', { class: 'key', text: key }),
          h(
            'td',
            null,
            value instanceof Node
              ? value
              : typeof value === 'object'
                ? h('pre', { text: json(value) })
                : h('span', { text: String(value) }),
          ),
        ),
      ),
    )
  }

  function objectTable(value) {
    if (!value || typeof value !== 'object' || Object.keys(value).length === 0) {
      return h('div', { class: 'empty', text: 'Empty.' })
    }
    return table(Object.entries(value))
  }

  function searchBox(value, onInput, placeholder) {
    const input = h('input', { type: 'search', placeholder, value })
    input.addEventListener('input', () => {
      onInput(input.value)
      const at = input.selectionStart
      render()
      const again = body.querySelector('input[type=search]')
      if (again) {
        again.focus()
        again.setSelectionRange(at, at)
      }
    })
    return input
  }

  const VIEWS = {
    request(profile) {
      const r = panelOf(profile, 'request')
      return [
        h('h3', { text: 'Route' }),
        table([
          ['Name', r.route],
          ['Pattern', r.pattern],
          ['Controller', r.controller],
          ['Params', r.params && Object.keys(r.params).length ? r.params : undefined],
        ]),
        h('h3', { text: 'Request' }),
        table([
          ['Method', profile.method],
          ['URL', profile.url],
          ['Path', r.path],
          ['IP', r.ip],
          ['Request id', r.requestId],
          ['AJAX', r.ajax ? 'yes' : undefined],
          ['Time', new Date(profile.time).toLocaleString()],
        ]),
        h('h3', { text: 'Query string' }),
        objectTable(r.query),
        h('h3', { text: 'Body' }),
        r.body === undefined
          ? h('div', { class: 'empty', text: 'No body.' })
          : h('pre', { text: json(r.body) }),
        h('h3', { text: 'Headers' }),
        objectTable(r.headers),
        h('h3', { text: 'Cookies' }),
        r.cookies?.length
          ? h(
              'div',
              null,
              r.cookies.map((name) => [h('span', { class: 'chip', text: name }), ' ']),
            )
          : h('div', { class: 'empty', text: 'None.' }),
        h('h3', { text: 'Session' }),
        r.session === undefined
          ? h('div', { class: 'empty', text: 'No session.' })
          : objectTable(r.session),
        h('h3', { text: 'User' }),
        r.user === undefined
          ? h('div', { class: 'empty', text: 'Guest.' })
          : h('pre', { text: json(r.user) }),
        h('h3', { text: 'Response' }),
        table([
          ['Status', profile.status],
          ['Content type', r.response?.contentType],
          ['Duration', ms(profile.duration)],
        ]),
        r.response ? objectTable(r.response.headers) : null,
      ]
    },

    queries(profile) {
      const q = queriesOf(profile)
      const f = state.filters
      if (q.total === 0) {
        return h('div', {
          class: 'empty',
          text: 'No query reached the profiler for this request. A data layer reports statements as `db:query` on the application emitter.',
        })
      }
      let rows = q.queries.slice()
      if (f.onlyDuplicates) rows = rows.filter((query) => query.copies > 1)
      if (f.query) {
        const needle = f.query.toLowerCase()
        rows = rows.filter((query) =>
          `${query.sql} ${JSON.stringify(query.bindings)}`.toLowerCase().includes(needle),
        )
      }
      if (f.sortBySlowest) rows.sort((a, b) => b.duration - a.duration)
      const max = Math.max(q.slowest, 0.0001)
      return [
        h(
          'div',
          { class: 'toolbar' },
          h('span', {
            text: `${q.total} statements · ${q.unique} unique · ${q.duplicates} duplicated · ${q.failed} failed · ${ms(q.duration)}`,
          }),
          q.capped
            ? h('span', {
                class: 'chip',
                dataset: { tone: 'warn' },
                text: `listing stopped at ${q.queries.length}`,
              })
            : null,
          searchBox(
            f.query,
            (value) => {
              f.query = value
            },
            'Filter SQL',
          ),
          h('button', {
            class: 'btn',
            dataset: f.onlyDuplicates ? { on: '' } : {},
            text: 'Only duplicates',
            onclick: () => {
              f.onlyDuplicates = !f.onlyDuplicates
              render()
            },
          }),
          h('button', {
            class: 'btn',
            dataset: f.sortBySlowest ? { on: '' } : {},
            text: 'Slowest first',
            onclick: () => {
              f.sortBySlowest = !f.sortBySlowest
              render()
            },
          }),
        ),
        h(
          'div',
          { class: 'list' },
          rows.map((query) => {
            const copyButton = h('button', {
              class: 'btn',
              text: 'copy',
              onclick: (event) => {
                event.stopPropagation()
                copy(query.sql, copyButton)
              },
            })
            return h(
              'div',
              {
                class: 'entry',
                dataset: { tone: query.error ? 'bad' : query.copies > 1 ? 'warn' : '' },
                onclick: (event) => {
                  if (getSelection()?.type === 'Range') return
                  event.currentTarget.toggleAttribute('data-expanded')
                },
              },
              h(
                'div',
                { class: 'num' },
                ms(query.duration),
                h('div', {
                  class: 'meter',
                  style: `width:${Math.max(4, (query.duration / max) * 100)}%`,
                }),
              ),
              h(
                'div',
                null,
                h('div', { class: 'sql', text: query.sql }),
                query.error ? h('div', { class: 'bad', text: query.error }) : null,
                h(
                  'div',
                  { class: 'meta' },
                  query.bindings?.length
                    ? h('span', { class: 'mono', text: JSON.stringify(query.bindings) })
                    : null,
                ),
              ),
              h(
                'div',
                null,
                query.copies > 1
                  ? [
                      h('span', {
                        class: 'chip',
                        dataset: { tone: 'warn' },
                        text: `× ${query.copies}`,
                      }),
                      ' ',
                    ]
                  : null,
                query.model ? [h('span', { class: 'chip', text: query.model }), ' '] : null,
                query.method ? [h('span', { class: 'chip', text: query.method }), ' '] : null,
                query.inTransaction ? [h('span', { class: 'chip', text: 'trx' }), ' '] : null,
                query.connection
                  ? [h('span', { class: 'chip', text: query.connection }), ' ']
                  : null,
                copyButton,
              ),
              h(
                'div',
                { class: 'extra' },
                table([
                  ['Started at', `+${ms(query.at)}`],
                  ['Bindings', query.bindings],
                  ['Copies', query.copies > 1 ? query.copies : undefined],
                ]),
              ),
            )
          }),
        ),
      ]
    },

    logs(profile) {
      const logs = logsOf(profile)
      const f = state.filters
      if (logs.total === 0)
        return h('div', { class: 'empty', text: 'Nothing was logged during this request.' })
      const levels = [...new Set(logs.lines.map((line) => line.level))]
      let lines = logs.lines.filter((line) => f.levels[line.level] !== false)
      if (f.logText) {
        const needle = f.logText.toLowerCase()
        lines = lines.filter((line) => line.message.toLowerCase().includes(needle))
      }
      const tone = (level) =>
        level === 'error' || level === 'fatal' ? 'bad' : level === 'warn' ? 'warn' : ''
      return [
        h(
          'div',
          { class: 'toolbar' },
          searchBox(
            f.logText,
            (value) => {
              f.logText = value
            },
            'Filter messages',
          ),
          levels.map((level) =>
            h('button', {
              class: 'chip',
              dataset: { tone: tone(level), ...(f.levels[level] === false ? { off: '' } : {}) },
              text: level,
              onclick: () => {
                f.levels[level] = f.levels[level] === false
                render()
              },
            }),
          ),
        ),
        h(
          'div',
          { class: 'list' },
          lines.map((line) =>
            h(
              'div',
              {
                class: 'entry',
                dataset: { tone: tone(line.level) },
                onclick: (event) => {
                  if (getSelection()?.type === 'Range') return
                  event.currentTarget.toggleAttribute('data-expanded')
                },
              },
              h('div', { class: 'num', text: `+${ms(line.at)}` }),
              h('div', { class: 'sql', text: line.message }),
              h('span', { class: 'chip', dataset: { tone: tone(line.level) }, text: line.level }),
              line.context
                ? h('div', { class: 'extra' }, h('pre', { text: json(line.context) }))
                : null,
            ),
          ),
        ),
      ]
    },

    events(profile) {
      const events = eventsOf(profile)
      const f = state.filters
      if (events.length === 0)
        return h('div', { class: 'empty', text: 'No event was emitted during this request.' })
      const shown = f.eventText
        ? events.filter((event) => event.name.toLowerCase().includes(f.eventText.toLowerCase()))
        : events
      return [
        h(
          'div',
          { class: 'toolbar' },
          h('span', { text: `${panelOf(profile, 'events').total || events.length} events` }),
          searchBox(
            f.eventText,
            (value) => {
              f.eventText = value
            },
            'Filter by name',
          ),
        ),
        h(
          'div',
          { class: 'list' },
          shown.map((event) =>
            h(
              'div',
              {
                class: 'entry',
                onclick: (e) => {
                  if (getSelection()?.type === 'Range') return
                  e.currentTarget.toggleAttribute('data-expanded')
                },
              },
              h('div', { class: 'num', text: `+${ms(event.at)}` }),
              h('div', { class: 'mono', text: event.name }),
              h('span', null),
              h('div', { class: 'extra' }, h('pre', { text: json(event.data) })),
            ),
          ),
        ),
      ]
    },

    timeline(profile) {
      const total = Math.max(Number(profile.duration) || 0, 0.001)
      const lanes = [
        { kind: 'request', name: `${profile.method} ${profile.url}`, at: 0, duration: total },
      ]
      for (const query of queriesOf(profile).queries) {
        lanes.push({ kind: 'query', name: query.sql, at: query.at, duration: query.duration })
      }
      for (const line of logsOf(profile).lines) {
        lanes.push({
          kind: 'log',
          name: `${line.level}: ${line.message}`,
          at: line.at,
          duration: 0,
        })
      }
      for (const event of eventsOf(profile)) {
        lanes.push({ kind: 'event', name: event.name, at: event.at, duration: 0 })
      }
      lanes.sort((a, b) => a.at - b.at || (a.kind === 'request' ? -1 : 1))
      return [
        h(
          'div',
          { class: 'toolbar' },
          ['request', 'query', 'log', 'event'].map((kind) =>
            h('span', { class: 'chip legend', dataset: { kind }, text: kind }),
          ),
          h('span', { text: `total ${ms(total)}` }),
        ),
        lanes.map((lane) =>
          h(
            'div',
            { class: 'lane' },
            h('div', {
              class: lane.kind === 'query' ? 'name mono' : 'name',
              text: lane.name,
              title: lane.name,
            }),
            h(
              'div',
              { class: 'track' },
              h('div', {
                class: 'span',
                dataset: { kind: lane.kind },
                style: `left:${Math.min(100, (lane.at / total) * 100)}%;width:${Math.min(100, (lane.duration / total) * 100)}%`,
              }),
            ),
            h('div', {
              class: 'num meta',
              text: lane.duration > 0 ? ms(lane.duration) : `+${ms(lane.at)}`,
            }),
          ),
        ),
      ]
    },

    cache(profile) {
      const cache = cacheOf(profile)
      return [
        h(
          'div',
          { class: 'toolbar' },
          h('span', {
            text: `${cache.hits} hits · ${cache.misses} misses · ${cache.writes} writes`,
          }),
        ),
        h(
          'table',
          null,
          h(
            'tr',
            null,
            h('th', { text: 'At' }),
            h('th', { text: 'Operation' }),
            h('th', { text: 'Key' }),
            h('th', { text: 'Store' }),
          ),
          cache.ops.map((op) =>
            h(
              'tr',
              null,
              h('td', { class: 'meta', text: `+${ms(op.at)}` }),
              h('td', { text: op.name.slice('cache:'.length) }),
              h('td', { class: 'mono', text: op.data?.key ?? '' }),
              h('td', { class: 'meta', text: op.data?.store ?? '' }),
            ),
          ),
        ),
      ]
    },

    mail(profile) {
      return h(
        'div',
        { class: 'list' },
        mailsOf(profile).map((event) =>
          h(
            'div',
            { class: 'entry', onclick: (e) => e.currentTarget.toggleAttribute('data-expanded') },
            h('div', { class: 'num', text: `+${ms(event.at)}` }),
            h('div', { class: 'mono', text: event.name }),
            h('span', null),
            h('div', { class: 'extra' }, h('pre', { text: json(event.data) })),
          ),
        ),
      )
    },

    exception(profile) {
      const e = panelOf(profile, 'exception')
      return [
        h('h3', { text: e.name || 'Error' }),
        h('div', { class: 'bad', text: e.message || '' }),
        e.code ? h('div', { class: 'meta', text: `code ${e.code}` }) : null,
        e.stack ? h('pre', { text: e.stack }) : null,
      ]
    },

    ajax() {
      return [
        h(
          'div',
          { class: 'toolbar' },
          h('span', { text: `${state.requests.length - 1} requests made by this page` }),
          h('button', {
            class: 'btn',
            text: 'Clear',
            onclick: () => {
              state.requests.splice(1)
              state.current = state.requests[0] || null
              render()
            },
          }),
        ),
        h(
          'table',
          null,
          h(
            'tr',
            null,
            ['#', 'Method', 'URL', 'Status', 'Time', 'Type', 'Profile'].map((label) =>
              h('th', { text: label }),
            ),
          ),
          state.requests.map((r, index) =>
            h(
              'tr',
              {
                class: r.profile ? 'pick' : '',
                dataset: state.current === r ? { active: '' } : {},
                onclick: () => {
                  if (!r.profile) return
                  state.current = r
                  state.tab = 'request'
                  render()
                },
              },
              h('td', { class: 'meta', text: index === 0 ? 'page' : String(index) }),
              h('td', { text: r.method }),
              h('td', { class: 'mono', text: r.url }),
              h(
                'td',
                null,
                h('span', {
                  class: 'chip',
                  dataset: { tone: statusTone(r.status) },
                  text: r.status || '—',
                }),
              ),
              h('td', { class: 'meta', text: ms(r.duration) }),
              h('td', { class: 'meta', text: r.kind }),
              h(
                'td',
                null,
                TOKEN.test(r.token || '')
                  ? h('a', {
                      href: `${base}/${r.token}`,
                      target: '_blank',
                      rel: 'noopener',
                      text: r.token,
                      onclick: (e) => e.stopPropagation(),
                    })
                  : h('span', { class: 'meta', text: 'n/a' }),
              ),
            ),
          ),
        ),
      ]
    },

    app(profile) {
      const app = panelOf(profile, 'app')
      const memory = panelOf(profile, 'memory')
      return [
        h('h3', { text: 'Application' }),
        table([
          ['ream', app.ream],
          ['Environment', app.environment],
          ['Profile token', profile.token],
          ['All profiles', h('a', { href: base, target: '_blank', rel: 'noopener', text: base })],
        ]),
        h('h3', { text: 'Runtime' }),
        table([
          ['Node.js', app.node],
          ['Platform', app.platform],
          ['Process id', app.pid],
          ['Uptime', app.uptime !== undefined ? `${app.uptime} s` : undefined],
          ['Heap used', mb(memory.usedMb)],
          ['Heap total', mb(memory.totalMb)],
          ['Resident', mb(memory.rssMb)],
        ]),
      ]
    },
  }

  // ── Render ──────────────────────────────────────────────

  function render() {
    const entry = state.current
    const profile = entry?.profile
    // Nothing to show until the page's profile has arrived.
    shell.style.display = profile || state.closed ? '' : 'none'
    shell.toggleAttribute('data-closed', state.closed)
    shell.toggleAttribute('data-open', Boolean(state.open && profile && !state.closed))
    if (profile) {
      renderBar(profile, entry)
      if (state.open && !state.closed) renderPanel(profile)
    }
    offsetPage()
  }

  function mount() {
    document.body.append(host)
    state.requests.unshift({
      kind: 'page',
      method: 'GET',
      url: location.pathname + location.search,
      token: pageToken,
      duration: 0,
    })
    load(state.requests[0])
    window.addEventListener('resize', () => {
      state.height = clampHeight(state.height)
      render()
    })
  }

  if (document.body) mount()
  else document.addEventListener('DOMContentLoaded', mount, { once: true })
})()
