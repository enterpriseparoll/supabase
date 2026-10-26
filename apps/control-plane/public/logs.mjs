import { LOG_LEVELS, LOG_SERVICES, logHistogram, logsCsv } from './logs.utils.mjs'

const node = (tag, text = '', classes = '') => {
  const result = document.createElement(tag)
  result.textContent = text
  result.className = classes
  return result
}
const levelClass = {
  error: 'text-danger',
  warning: 'text-warning',
  info: 'text-brand',
  debug: 'text-subtle',
}

export async function renderProjectLogs(project, root, { api, button }) {
  if (!['owner', 'operator'].includes(project.role)) {
    root.append(
      node('p', 'Owner or operator access is required to view service logs.', 'text-sm text-subtle')
    )
    return
  }
  let result,
    busy = false,
    live = false,
    timer,
    selectedEntry
  const active = () => root.isConnected && (root.closest('dialog')?.open ?? true)
  const intro = node('div', '', 'space-y-1')
  intro.append(
    node('h3', 'Project logs', 'font-semibold'),
    node(
      'p',
      'Inspect recent events from your project services. Select an entry to view its details.',
      'text-sm text-subtle'
    )
  )
  const form = node('form', '', 'logs-toolbar')
  const select = (label, name, options) => {
    const wrapper = node('label', label, 'grid gap-1.5 text-xs text-subtle')
    const input = document.createElement('select')
    input.name = name
    input.setAttribute('aria-label', label)
    for (const [value, text] of options) {
      const option = node('option', text)
      option.value = value
      input.append(option)
    }
    wrapper.append(input)
    form.append(wrapper)
    input.addEventListener('change', () => form.requestSubmit())
    return input
  }
  select('Time range', 'minutes', [
    ['60', 'Last 60 minutes'],
    ['15', 'Last 15 minutes'],
    ['360', 'Last 6 hours'],
    ['1440', 'Last 24 hours'],
  ])
  select('Log type', 'service', [['all', 'All services'], ...Object.entries(LOG_SERVICES)])
  select('Level', 'level', [
    ['all', 'All levels'],
    ...LOG_LEVELS.map((level) => [level, level[0].toUpperCase() + level.slice(1)]),
  ])
  const searchLabel = node('label', 'Search', 'grid gap-1.5 text-xs text-subtle')
  const search = document.createElement('input')
  search.name = 'search'
  search.type = 'search'
  search.maxLength = 200
  search.placeholder = 'Search messages or paths'
  searchLabel.append(search)
  form.append(searchLabel)
  const apply = node('button', 'Refresh logs', 'self-end whitespace-nowrap')
  apply.type = 'submit'
  form.append(apply)
  const actions = node('div', '', 'flex flex-wrap items-center justify-between gap-3')
  const summary = node('p', 'Loading logs…', 'text-xs text-subtle')
  summary.setAttribute('role', 'status')
  const buttons = node('div', '', 'flex items-center gap-2')
  const toggle = button('Start live', async () => {
    live = !live
    toggle.setAttribute('aria-pressed', String(live))
    toggle.textContent = live ? 'Stop live' : 'Start live'
    if (live) await load()
    else clearTimeout(timer)
  })
  toggle.setAttribute('aria-pressed', 'false')
  const download = button('Download CSV', () => {
    const url = URL.createObjectURL(
      new Blob([logsCsv(result.entries)], { type: 'text/csv;charset=utf-8' })
    )
    const anchor = node('a')
    anchor.href = url
    anchor.download = `${project.id}-logs-${new Date().toISOString().slice(0, 10)}.csv`
    anchor.hidden = true
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  })
  download.disabled = true
  buttons.append(toggle, download)
  actions.append(summary, buttons)
  const error = node(
    'p',
    '',
    'rounded-lg border border-danger/25 bg-danger/5 p-3 text-sm text-danger'
  )
  error.setAttribute('role', 'alert')
  error.hidden = true
  const histogram = node('div', '', 'logs-histogram')
  const list = node('div', '', 'logs-list')
  const details = node('section', '', 'space-y-3 rounded-lg border border-border bg-surface p-4')
  details.hidden = true
  const note = node(
    'p',
    'History is limited to logs retained by Docker. Each request reads up to 500 recent entries per service and displays up to 500 matches. Known credentials are redacted. Times use your browser’s time zone.',
    'text-xs leading-5 text-subtle'
  )
  root.append(intro, form, actions, error, histogram, list, details, note)

  function renderDetails(entry) {
    selectedEntry = entry
    details.replaceChildren()
    details.hidden = false
    const heading = node('div', '', 'flex items-center justify-between gap-3')
    heading.append(
      node('h4', 'Log entry details', 'font-medium text-sm'),
      button('Close details', () => {
        details.hidden = true
        selectedEntry = null
      })
    )
    details.append(
      heading,
      node(
        'p',
        `${entry.source} · ${entry.level} · ${new Date(entry.timestamp).toLocaleString()}`,
        'text-xs text-subtle'
      )
    )
    details.append(
      node(
        'pre',
        JSON.stringify(entry, null, 2),
        'max-h-80 overflow-auto whitespace-pre-wrap break-all font-mono text-xs leading-6'
      )
    )
    details.scrollIntoView({ behavior: 'instant', block: 'nearest' })
  }

  function render() {
    const rows = result.entries
    summary.textContent = `${rows.length} recent ${rows.length === 1 ? 'entry' : 'entries'}${live ? ' · Live refresh every 5 seconds' : ''}${result.limited ? ' · Result limit reached; narrow your filters' : ''}`
    if (result.unavailable.length)
      summary.textContent += ` · Unavailable: ${result.unavailable.join(', ')}`
    download.disabled = rows.length === 0
    histogram.replaceChildren()
    histogram.setAttribute('role', 'img')
    histogram.setAttribute(
      'aria-label',
      'Event counts in these results over the selected time range'
    )
    const counts = logHistogram(rows, result.start, result.end)
    const maximum = Math.max(1, ...counts)
    for (const count of counts) {
      const bar = node('span', '', count ? 'logs-bar bg-brand/60' : 'logs-bar bg-muted')
      bar.style.height = `${Math.max(4, (count / maximum) * 100)}%`
      bar.title = `${count} ${count === 1 ? 'entry' : 'entries'} in these results`
      histogram.append(bar)
    }
    list.replaceChildren()
    if (!rows.length) {
      list.append(
        node(
          'p',
          'No logs match these filters. Try a longer time range or another service.',
          'p-8 text-center text-sm text-subtle'
        )
      )
      return
    }
    const table = node('table', '', 'w-full table-fixed text-xs')
    const caption = node(
      'caption',
      'Recent project service logs. Select a message to view the complete entry.',
      'sr-only'
    )
    const head = node('thead', '', 'sticky top-0 bg-surface text-left text-subtle')
    const headings = node('tr')
    for (const [label, width] of [
      ['Time', 'w-36'],
      ['Type', 'w-28'],
      ['Level', 'w-20'],
      ['Event message', ''],
    ]) {
      const cell = node('th', label, `${width} px-3 py-3 font-medium`)
      cell.scope = 'col'
      headings.append(cell)
    }
    head.append(headings)
    const body = node('tbody', '', 'divide-y divide-border')
    for (const entry of rows) {
      const row = node('tr', '', 'hover:bg-muted/50')
      row.append(
        node('td', new Date(entry.timestamp).toLocaleString(), 'px-3 py-3 align-top text-subtle'),
        node('td', entry.source, 'px-3 py-3 align-top')
      )
      row.append(
        node('td', entry.level, `px-3 py-3 align-top ${levelClass[entry.level] ?? 'text-subtle'}`)
      )
      const message = node('td', '', 'px-3 py-2 align-top')
      const link = button(entry.message, () => renderDetails(entry))
      link.className = 'logs-message'
      link.setAttribute('aria-label', `View log entry: ${entry.message.slice(0, 120)}`)
      message.append(link)
      row.append(message)
      body.append(row)
    }
    table.append(caption, head, body)
    list.append(table)
    if (selectedEntry) {
      const updated = rows.find((entry) => entry.id === selectedEntry.id)
      if (updated) selectedEntry = updated
    }
  }

  async function load() {
    if (busy || !active()) return
    clearTimeout(timer)
    const query = new URLSearchParams(new FormData(form))
    query.set('limit', '500')
    busy = true
    form.setAttribute('aria-busy', 'true')
    apply.textContent = 'Loading…'
    for (const input of form.elements) input.disabled = true
    error.hidden = true
    try {
      const next = await api(`/api/projects/${project.id}/logs?${query}`)
      if (!active()) return
      result = next
      render()
    } catch (failure) {
      if (!active()) return
      error.textContent = failure.message
      error.hidden = false
      summary.textContent = result
        ? 'Could not refresh. Showing the last result.'
        : 'Logs could not be loaded.'
      live = false
      toggle.textContent = 'Start live'
      toggle.setAttribute('aria-pressed', 'false')
    } finally {
      busy = false
      form.removeAttribute('aria-busy')
      apply.textContent = 'Refresh logs'
      for (const input of form.elements) input.disabled = false
      if (live && active())
        timer = setTimeout(() => {
          if (document.hidden) schedule()
          else void load()
        }, 5000)
    }
  }
  function schedule() {
    if (live && active())
      timer = setTimeout(() => {
        if (document.hidden) schedule()
        else void load()
      }, 5000)
  }
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    selectedEntry = null
    details.hidden = true
    void load()
  })
  await load()
}
