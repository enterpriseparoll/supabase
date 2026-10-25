const $ = (id) => document.getElementById(id)
const projects = new Map()
let me,
  nextCursor = '',
  confirmationAction,
  selected
async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.method ? { 'Idempotency-Key': crypto.randomUUID() } : {}),
      ...options.headers,
    },
  })
  const value = await response.json()
  if (!response.ok) {
    const error = new Error(value.error ?? 'Request failed')
    error.status = response.status
    throw error
  }
  return value
}
function notice(message) {
  $('notice').textContent = message
  const dialog = [...document.querySelectorAll('dialog[open]')].at(-1)
  if (dialog) {
    let status = dialog.querySelector('[data-status]')
    if (!status) {
      status = element('p', '', 'my-4 text-sm')
      status.dataset.status = 'true'
      status.setAttribute('role', 'status')
      dialog.append(status)
    }
    status.textContent = message
  }
}
function element(tag, text, classes = '') {
  const node = document.createElement(tag)
  node.textContent = text
  node.className = classes
  return node
}
function button(text, action) {
  const node = element('button', text)
  node.type = 'button'
  node.addEventListener('click', async () => {
    node.disabled = true
    try {
      await action()
    } catch (error) {
      notice(error.message)
    } finally {
      node.disabled = false
    }
  })
  return node
}
async function operation(project, kind, extra = {}) {
  const result = await api(`/api/projects/${project.id}/operations`, {
    method: 'POST',
    body: JSON.stringify({ kind, ...extra }),
  })
  notice(`${kind} queued. Operation ${result.id}.`)
  await loadProjects(true)
}
function confirm(project, kind, extra = {}) {
  $('confirm-form').reset()
  $('confirm-title').textContent = kind === 'delete' ? 'Delete project' : 'Restore backup'
  $('confirm-description').textContent =
    `Type ${project.id} to continue. ${kind === 'delete' ? 'This stops the stack and removes its public routes. Data remains on disk.' : 'This replaces the database and Storage files with the selected backup. The project will be unavailable during restore.'}`
  confirmationAction = async (value) => {
    if (value !== project.id) throw new Error('Project ID does not match')
    await operation(project, kind, { ...extra, confirmation: value })
  }
  $('confirm-dialog').showModal()
}
// Changing memory/CPU restarts the project with the new limits. Data is kept.
function resourcesForm(project) {
  const form = element('form', '', 'space-y-4 rounded border border-border p-4')
  form.append(element('h3', 'Resources', 'font-semibold'))
  form.append(
    element(
      'p',
      'Saving restarts this project with the new limits. Data is kept. The project is unavailable for a few minutes.',
      'text-sm text-subtle'
    )
  )
  const grid = element('div', '', 'grid grid-cols-2 gap-4')
  const field = (label, name, value, attributes) => {
    const wrapper = element('label', label, 'block text-sm')
    const input = document.createElement('input')
    Object.assign(input, { name, type: 'number', required: true, value: String(value) })
    for (const [key, attribute] of Object.entries(attributes)) input.setAttribute(key, attribute)
    input.className = 'mt-2'
    wrapper.append(input)
    return wrapper
  }
  grid.append(
    field('Memory (MiB)', 'memoryMb', project.memoryMb, { min: 2048, max: 131072, step: 512 }),
    field('CPU', 'cpus', project.cpus, { min: 1, max: 32, step: 0.5 })
  )
  form.append(grid)
  const save = element('button', 'Save and restart')
  save.type = 'submit'
  form.append(save)
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const values = Object.fromEntries(new FormData(form))
    save.disabled = true
    try {
      await operation(project, 'resize', {
        memoryMb: Number(values.memoryMb),
        cpus: Number(values.cpus),
      })
      detail(await api(`/api/projects/${project.id}`))
    } catch (error) {
      notice(error.message)
    } finally {
      save.disabled = false
    }
  })
  return form
}
// The project drawer is split into tabs; the chosen tab is kept across projects.
const detailTabs = {
  Overview: renderOverview,
  Backups: renderBackups,
  Migrations: renderMigrations,
  Schema: renderSchema,
  Performance: renderPerformance,
}
let activeTab = 'Overview'
async function detail(project) {
  selected = project.id
  const root = $('detail')
  root.replaceChildren()
  $('detail-title').textContent = project.name
  const bar = element('div', '', 'flex flex-wrap gap-2 border-b border-border pb-3')
  bar.setAttribute('role', 'tablist')
  bar.setAttribute('aria-label', 'Project sections')
  const panel = element('div', '', 'space-y-5 pt-2')
  panel.setAttribute('role', 'tabpanel')
  for (const name of Object.keys(detailTabs)) {
    const tab = element('button', name, name === activeTab ? 'bg-muted font-semibold' : '')
    tab.type = 'button'
    tab.setAttribute('role', 'tab')
    tab.setAttribute('aria-selected', String(name === activeTab))
    tab.addEventListener('click', () => {
      activeTab = name
      detail(project).catch((error) => notice(error.message))
    })
    bar.append(tab)
  }
  root.append(bar, panel)
  if (!$('detail-dialog').open) $('detail-dialog').showModal()
  try {
    await detailTabs[activeTab](project, panel)
  } catch (error) {
    if (selected === project.id) panel.append(element('p', error.message, 'text-sm'))
  }
}
async function renderOverview(project, root) {
  const metadata = element('div', '', 'space-y-2 text-sm')
  for (const line of [
    `Project ID: ${project.id}`,
    `API URL: ${project.apiUrl}`,
    `Status: ${project.status}`,
    `Allocation: ${project.memoryMb} MiB / ${project.cpus} CPU`,
    `Last observed: ${project.lastObservedAt ?? 'Not observed yet'}`,
    ...(project.databaseUrl ? [`Database (session pooler): ${project.databaseUrl}`] : []),
  ])
    metadata.append(element('p', line, 'break-all'))
  root.append(metadata)
  root.append(
    button('Refresh status', async () => detail(await api(`/api/projects/${project.id}`)))
  )
  const canOperate = ['owner', 'operator'].includes(project.role)
  if (canOperate) {
    const actions = element('div', '', 'flex flex-wrap gap-2')
    actions.append(
      button('Open Studio', async () => {
        const ticket = await api(`/api/projects/${project.id}/studio-ticket`, {
          method: 'POST',
          body: '{}',
        })
        location.assign(ticket.url)
      })
    )
    for (const kind of ['start', 'stop', 'restart', 'backup'])
      actions.append(
        button(`${kind[0].toUpperCase()}${kind.slice(1)}`, () => operation(project, kind))
      )
    actions.append(
      button('Show credentials', async () => {
        const credentials = await api(`/api/projects/${project.id}/secrets`, {
          method: 'POST',
          body: '{}',
        })
        const panel = element(
          'pre',
          JSON.stringify(credentials, null, 2),
          'max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-4 text-xs'
        )
        root.append(panel)
        panel.append(button('Hide credentials', () => panel.remove()))
      })
    )
    if (project.role === 'owner')
      actions.append(button('Delete project', () => confirm(project, 'delete')))
    root.append(actions)
    root.append(resourcesForm(project))
  }
  root.append(element('h3', 'Resource usage', 'font-semibold'))
  root.append(
    element(
      'pre',
      JSON.stringify(project.metrics, null, 2),
      'max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted p-4 text-xs'
    )
  )
  const [operations, backups, domains] = await Promise.all(
    ['operations', 'backups', 'domains'].map((resource) =>
      api(`/api/projects/${project.id}/${resource}`)
    )
  )
  if (selected !== project.id) return
  root.append(element('h3', 'Recent operations', 'font-semibold'))
  const list = element('ul', '', 'space-y-2 text-sm')
  for (const row of operations)
    list.append(
      element(
        'li',
        `${row.kind} · ${row.state} · ${row.error_code ?? ''} · ${new Date(row.created_at).toLocaleString()}`
      )
    )
  root.append(list)
  root.append(element('h3', 'Backups', 'font-semibold'))
  if (!backups.length)
    root.append(
      element(
        'p',
        'No completed backups. Configure the off-server repository, then create a backup.',
        'text-sm text-subtle'
      )
    )
  for (const row of backups) {
    const line = element('div', '', 'flex flex-wrap items-center justify-between gap-2 text-sm')
    line.append(element('span', new Date(row.created_at).toLocaleString()))
    if (project.role === 'owner')
      line.append(button('Restore backup', () => confirm(project, 'restore', { backupId: row.id })))
    root.append(line)
  }
  root.append(element('h3', 'Custom domains', 'font-semibold'))
  for (const row of domains) {
    root.append(
      element(
        'p',
        `${row.domain} · ${row.verified_at ? 'Verified' : 'Awaiting DNS verification'}`,
        'text-sm'
      )
    )
    if (!row.verified_at)
      root.append(
        element(
          'pre',
          `TXT _supabase-platform.${row.domain}\n${row.verification_token}`,
          'overflow-auto whitespace-pre-wrap rounded bg-muted p-3 text-xs'
        )
      )
    if (canOperate) {
      root.append(
        button('Verify domain', () => operation(project, 'verify-domain', { domain: row.domain }))
      )
      root.append(
        button('Remove domain', async () => {
          await api(`/api/projects/${project.id}/domains`, {
            method: 'DELETE',
            body: JSON.stringify({ domain: row.domain }),
          })
          await detail(project)
        })
      )
    }
  }
  if (canOperate) {
    const form = element('form', '', 'flex gap-3')
    const input = document.createElement('input')
    input.name = 'domain'
    input.placeholder = 'api.example.com'
    input.required = true
    input.setAttribute('aria-label', 'Custom API domain')
    const submit = element('button', 'Add domain')
    submit.type = 'submit'
    form.append(input, submit)
    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      submit.disabled = true
      try {
        await api(`/api/projects/${project.id}/domains`, {
          method: 'POST',
          body: JSON.stringify({ domain: input.value }),
        })
        await detail(project)
      } catch (error) {
        notice(error.message)
      } finally {
        submit.disabled = false
      }
    })
    root.append(form)
    root.append(
      element(
        'p',
        `Point the custom domain to this server and add the TXT record above before verification. Auth keeps its default project URL.`,
        'text-sm text-subtle'
      )
    )
  }
}
// ---- Formatting and small UI helpers for the insight tabs ----
const formatBytes = (value) => {
  if (value === null || value === undefined) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let size = Number(value),
    unit = 0
  while (size >= 1024 && unit < units.length - 1) ((size /= 1024), unit++)
  return `${size.toFixed(size >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`
}
const formatTime = (value) => (value ? new Date(value).toLocaleString() : '—')
const formatPercent = (value) =>
  value === null || value === undefined ? '—' : `${(Number(value) * 100).toFixed(1)}%`
// Supabase migration versions are UTC timestamps (YYYYMMDDHHMMSS).
const formatVersion = (version) => {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(version ?? '')
  return match
    ? new Date(
        Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6])
      ).toLocaleString()
    : version
}
function section(root, title, description) {
  const wrapper = element('section', '', 'space-y-3')
  wrapper.append(element('h3', title, 'font-semibold'))
  if (description) wrapper.append(element('p', description, 'text-sm text-subtle'))
  root.append(wrapper)
  return wrapper
}
function table(headers, rows) {
  const wrapper = element('div', '', 'overflow-x-auto rounded border border-border')
  const node = element('table', '', 'w-full text-left text-sm')
  const head = element('tr', '', 'border-b border-border bg-muted')
  for (const header of headers) head.append(element('th', header, 'px-3 py-2 font-medium'))
  node.append(head)
  for (const row of rows) {
    const line = element('tr', '', 'border-b border-border align-top')
    for (const cell of row) {
      const td = element('td', '', 'px-3 py-2')
      if (cell instanceof Node) td.append(cell)
      else td.textContent = cell ?? '—'
      line.append(td)
    }
    node.append(line)
  }
  wrapper.append(node)
  return wrapper
}
function stat(label, value, hint) {
  const card = element('div', '', 'rounded border border-border p-3')
  card.append(element('p', label, 'text-xs text-subtle'))
  card.append(element('p', value, 'text-lg font-semibold'))
  if (hint) card.append(element('p', hint, 'text-xs text-subtle'))
  return card
}
// Inline SVG trend line. Uses currentColor so it follows light and dark themes.
function sparkline(values, label) {
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', '0 0 240 48')
  svg.setAttribute('class', 'h-12 w-full')
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', label)
  const points = values.filter((value) => Number.isFinite(value))
  if (points.length < 2) return element('p', 'Not enough samples yet.', 'text-xs text-subtle')
  const min = Math.min(...points),
    max = Math.max(...points),
    span = max - min || 1
  const line = document.createElementNS(ns, 'polyline')
  line.setAttribute(
    'points',
    points
      .map((value, index) => {
        const x = (index / (points.length - 1)) * 236 + 2
        const y = 44 - ((value - min) / span) * 40
        return `${x.toFixed(1)},${y.toFixed(1)}`
      })
      .join(' ')
  )
  line.setAttribute('fill', 'none')
  line.setAttribute('stroke', 'currentColor')
  line.setAttribute('stroke-width', '2')
  line.setAttribute('vector-effect', 'non-scaling-stroke')
  svg.append(line)
  return svg
}
function refreshInsightsButton(project) {
  return button('Collect now', async () => {
    await api(`/api/projects/${project.id}/operations`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'inspect' }),
    })
    notice('Collecting database details. Refresh this tab in a few seconds.')
  })
}
function insightsStatus(root, insights) {
  if (insights.errorCode)
    root.append(
      element(
        'p',
        'The last collection failed. The project may be starting, or its database is unreachable. Check the worker logs if this continues.',
        'text-sm'
      )
    )
  root.append(
    element(
      'p',
      insights.collectedAt
        ? `Collected ${formatTime(insights.collectedAt)}. Updated every few minutes while the project runs.`
        : 'Not collected yet. Details appear a few minutes after the project is ready.',
      'text-xs text-subtle'
    )
  )
}

// ---- Backups ----
async function renderBackups(project, root) {
  const canOperate = ['owner', 'operator'].includes(project.role)
  const [backups, operations] = await Promise.all([
    api(`/api/projects/${project.id}/backups`),
    api(`/api/projects/${project.id}/operations`),
  ])
  if (selected !== project.id) return
  const schedule = section(
    root,
    'Automatic backups',
    'Backups run while the project stays online and are encrypted and deduplicated, so repeat backups only store what changed.'
  )
  const latest = backups[0]
  const interval = project.backupIntervalHours
  schedule.append(
    element(
      'p',
      interval
        ? `Every ${interval} hours, keeping the newest ${project.backupRetention}. ${
            latest
              ? `Next backup after ${formatTime(new Date(latest.created_at).getTime() + interval * 3600000)}.`
              : 'The first backup runs within a minute.'
          }`
        : 'Automatic backups are off.',
      'text-sm'
    )
  )
  if (canOperate) {
    const form = element('form', '', 'grid grid-cols-2 gap-4')
    const frequency = element('label', 'Frequency', 'block text-sm')
    const select = document.createElement('select')
    select.name = 'intervalHours'
    select.className = 'mt-2'
    for (const [value, label] of [
      [0, 'Off'],
      [6, 'Every 6 hours'],
      [12, 'Every 12 hours'],
      [24, 'Daily'],
      [168, 'Weekly'],
    ]) {
      const option = new Option(label, String(value), false, value === interval)
      select.append(option)
    }
    if (![0, 6, 12, 24, 168].includes(interval))
      select.append(new Option(`Every ${interval} hours`, String(interval), true, true))
    frequency.append(select)
    const keep = element('label', 'Backups to keep', 'block text-sm')
    const count = document.createElement('input')
    Object.assign(count, { name: 'retention', type: 'number', min: 1, max: 365, required: true })
    count.value = String(project.backupRetention)
    count.className = 'mt-2'
    keep.append(count)
    const save = element('button', 'Save schedule')
    save.type = 'submit'
    const actions = element('div', '', 'col-span-2 flex flex-wrap gap-2')
    actions.append(
      save,
      button('Back up now', () => operation(project, 'backup'))
    )
    form.append(frequency, keep, actions)
    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      save.disabled = true
      try {
        await api(`/api/projects/${project.id}/backup-settings`, {
          method: 'POST',
          body: JSON.stringify({
            intervalHours: Number(select.value),
            retention: Number(count.value),
          }),
        })
        notice('Backup schedule saved.')
        detail(await api(`/api/projects/${project.id}`))
      } catch (error) {
        notice(error.message)
      } finally {
        save.disabled = false
      }
    })
    schedule.append(form)
  }
  const list = section(
    root,
    'Backups',
    'Download gives the same file as Supabase Cloud: a gzipped SQL dump of all roles and databases, without passwords or Storage files. Restoring replaces the database and Storage files. A safety backup is taken first, and the previous database is kept on the server until the next restore.'
  )
  if (!backups.length) list.append(element('p', 'No backups yet.', 'text-sm text-subtle'))
  else
    list.append(
      table(
        ['Created', 'Type', 'Size', ''],
        backups.map((row) => [
          formatTime(row.created_at),
          { manual: 'Manual', scheduled: 'Scheduled', 'pre-restore': 'Before restore' }[
            row.trigger
          ] ?? row.trigger,
          formatBytes(row.size_bytes),
          backupActions(project, row),
        ])
      )
    )
  const history = operations.filter((row) => ['backup', 'restore'].includes(row.kind)).slice(0, 10)
  if (history.length) {
    const recent = section(root, 'Recent backup activity')
    recent.append(
      table(
        ['Started', 'Action', 'Result'],
        history.map((row) => [
          formatTime(row.created_at),
          row.kind === 'backup' ? 'Backup' : 'Restore',
          row.state === 'failed' ? `Failed (${row.error_code ?? 'unknown'})` : row.state,
        ])
      )
    )
  }
}

function backupActions(project, row) {
  const actions = element('div', '', 'flex flex-wrap gap-2')
  if (['owner', 'operator'].includes(project.role) && row.download_bytes !== null)
    actions.append(
      button(`Download (${formatBytes(row.download_bytes)})`, () => downloadBackup(project, row))
    )
  if (project.role === 'owner')
    actions.append(button('Restore', () => confirm(project, 'restore', { backupId: row.id })))
  return actions.childElementCount ? actions : ''
}
async function downloadBackup(project, row) {
  const response = await fetch(`/api/projects/${project.id}/backups/${row.id}/download`, {
    credentials: 'same-origin',
  })
  if (!response.ok) {
    const value = await response.json().catch(() => ({}))
    throw new Error(value.error ?? 'Download failed')
  }
  const name =
    /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') ?? '')?.[1] ??
    'db_cluster.backup.gz'
  const link = document.createElement('a')
  link.href = URL.createObjectURL(await response.blob())
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(link.href), 60000)
}

// ---- Migration history ----
async function renderMigrations(project, root) {
  const insights = await api(`/api/projects/${project.id}/insights`)
  if (selected !== project.id) return
  const wrapper = section(
    root,
    'Migration history',
    'Migrations applied with the Supabase CLI (supabase db push or migration up), read from supabase_migrations.schema_migrations.'
  )
  insightsStatus(wrapper, insights)
  if (['owner', 'operator'].includes(project.role)) wrapper.append(refreshInsightsButton(project))
  const migrations = insights.migrations ?? []
  if (!migrations.length) {
    wrapper.append(
      element(
        'p',
        insights.collectedAt
          ? 'No migrations recorded. Changes made in Studio or SQL directly are not migrations; use Schema to track them.'
          : '',
        'text-sm text-subtle'
      )
    )
    return
  }
  wrapper.append(
    element(
      'p',
      `${migrations.length} applied. Latest: ${migrations.at(-1).name ?? migrations.at(-1).version}.`,
      'text-sm'
    )
  )
  wrapper.append(
    table(
      ['Version', 'Applied migration', 'Statements'],
      [...migrations]
        .reverse()
        .map((row) => [
          element('span', formatVersion(row.version), 'whitespace-nowrap'),
          row.name ?? row.version,
          String(row.statements),
        ])
    )
  )
}

// ---- Schema snapshots and comparison ----
async function renderSchema(project, root) {
  const snapshots = await api(`/api/projects/${project.id}/schema-snapshots`)
  if (selected !== project.id) return
  const intro = section(
    root,
    'Schema history',
    'A snapshot of your tables, views, functions, and policies (outside Supabase-managed schemas) is saved whenever it changes. Compare any two snapshots, including another project’s.'
  )
  if (['owner', 'operator'].includes(project.role)) intro.append(refreshInsightsButton(project))
  if (!snapshots.length) {
    intro.append(
      element(
        'p',
        'No snapshots yet. The first one appears a few minutes after the project is ready.',
        'text-sm text-subtle'
      )
    )
    return
  }
  intro.append(
    table(
      ['Saved', 'Size'],
      snapshots.map((row) => [formatTime(row.createdAt), formatBytes(row.sizeBytes)])
    )
  )
  // Other projects' latest snapshots are offered as comparison targets.
  const others = [...projects.values()].filter((row) => row.id !== project.id).slice(0, 30)
  const otherLatest = (
    await Promise.all(
      others.map(async (row) => {
        try {
          const [latest] = await api(`/api/projects/${row.id}/schema-snapshots`)
          return latest ? { project: row, snapshot: latest } : null
        } catch {
          return null
        }
      })
    )
  ).filter(Boolean)
  if (selected !== project.id) return
  const compare = section(root, 'Compare schemas')
  const form = element('form', '', 'grid gap-4 sm:grid-cols-2')
  const picker = (label, name, selectedId) => {
    const wrapper = element('label', label, 'block text-sm')
    const select = document.createElement('select')
    select.name = name
    select.className = 'mt-2'
    const own = document.createElement('optgroup')
    own.label = project.name
    snapshots.forEach((row, index) =>
      own.append(
        new Option(
          `${index === 0 ? 'Current' : 'Earlier'} · ${formatTime(row.createdAt)}`,
          row.id,
          false,
          row.id === selectedId
        )
      )
    )
    select.append(own)
    if (otherLatest.length) {
      const group = document.createElement('optgroup')
      group.label = 'Other projects (current)'
      for (const { project: other, snapshot } of otherLatest)
        group.append(new Option(other.name, snapshot.id))
      select.append(group)
    }
    wrapper.append(select)
    return { wrapper, select }
  }
  const from = picker('From', 'from', (snapshots[1] ?? snapshots[0]).id)
  const to = picker('To', 'to', snapshots[0].id)
  const run = element('button', 'Compare')
  run.type = 'submit'
  const actions = element('div', '', 'sm:col-span-2')
  actions.append(run)
  form.append(from.wrapper, to.wrapper, actions)
  const output = element('div', '', 'space-y-3')
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    run.disabled = true
    output.replaceChildren(element('p', 'Comparing…', 'text-sm text-subtle'))
    try {
      const diff = await api(
        `/api/schema-diff?from=${encodeURIComponent(from.select.value)}&to=${encodeURIComponent(to.select.value)}`
      )
      renderDiff(output, diff)
    } catch (error) {
      output.replaceChildren(element('p', error.message, 'text-sm'))
    } finally {
      run.disabled = false
    }
  })
  compare.append(form, output)
}
function renderDiff(root, diff) {
  root.replaceChildren()
  const label = (side) => `${side.projectName} (${formatTime(side.createdAt)})`
  root.append(
    element(
      'p',
      diff.hunks.length
        ? `${label(diff.from)} → ${label(diff.to)}: ${diff.added} lines added, ${diff.removed} removed.`
        : 'The schemas are identical.',
      'text-sm'
    )
  )
  for (const hunk of diff.hunks) {
    const block = element('pre', '', 'overflow-x-auto rounded border border-border text-xs')
    block.append(
      element(
        'div',
        `@@ line ${hunk.fromLine} → ${hunk.toLine} @@`,
        'bg-muted px-3 py-1 text-subtle'
      )
    )
    for (const line of hunk.lines)
      block.append(
        element(
          'div',
          `${line.type} ${line.text}`,
          line.type === '+'
            ? 'px-3 text-green-700 dark:text-green-400'
            : line.type === '-'
              ? 'px-3 text-red-700 dark:text-red-400'
              : 'px-3'
        )
      )
    root.append(block)
  }
}

// ---- Performance ----
async function renderPerformance(project, root) {
  const [insights, samples] = await Promise.all([
    api(`/api/projects/${project.id}/insights`),
    api(`/api/projects/${project.id}/stats?hours=24`),
  ])
  if (selected !== project.id) return
  const overview = section(root, 'Database performance')
  insightsStatus(overview, insights)
  if (['owner', 'operator'].includes(project.role)) overview.append(refreshInsightsButton(project))
  const performance = insights.performance
  if (!performance) return
  const connections = performance.connections ?? {}
  const cards = element('div', '', 'grid grid-cols-2 gap-3 sm:grid-cols-3')
  cards.append(
    stat('Database size', formatBytes(performance.database_bytes)),
    stat(
      'Connections',
      `${connections.total ?? 0} / ${performance.max_connections ?? '—'}`,
      `${connections.active ?? 0} active, ${connections.idle_in_transaction ?? 0} idle in transaction`
    ),
    stat('Cache hit rate', formatPercent(performance.cache_hit_ratio), 'Aim for 99% or higher'),
    stat(
      'Longest running query',
      `${connections.longest_active_seconds ?? 0}s`,
      'At collection time'
    ),
    stat('Deadlocks', String(performance.counters?.deadlocks ?? 0), 'Since the database started'),
    stat(
      'Rollbacks',
      String(performance.counters?.xact_rollback ?? 0),
      `of ${performance.counters?.xact_commit ?? 0} commits`
    )
  )
  overview.append(cards)
  // Trends over the last 24 hours; commit counters become per-minute rates.
  const trends = section(root, 'Last 24 hours')
  const rates = samples.slice(1).map((row, index) => {
    const previous = samples[index]
    const minutes = (new Date(row.collectedAt) - new Date(previous.collectedAt)) / 60000
    const delta = row.sample.xact_commit - previous.sample.xact_commit
    return minutes > 0 && delta >= 0 ? delta / minutes : NaN
  })
  const grid = element('div', '', 'grid gap-4 sm:grid-cols-2')
  for (const [label, values, latest] of [
    [
      'Database size',
      samples.map((row) => row.sample.database_bytes),
      formatBytes(samples.at(-1)?.sample.database_bytes),
    ],
    [
      'Connections',
      samples.map((row) => row.sample.connections),
      String(samples.at(-1)?.sample.connections ?? '—'),
    ],
    [
      'Transactions per minute',
      rates,
      Number.isFinite(rates.at(-1)) ? rates.at(-1).toFixed(1) : '—',
    ],
    [
      'Cache hit rate',
      samples.map((row) => row.sample.cache_hit_ratio),
      formatPercent(samples.at(-1)?.sample.cache_hit_ratio),
    ],
  ]) {
    const card = element('div', '', 'rounded border border-border p-3')
    const heading = element('div', '', 'flex items-baseline justify-between gap-2')
    heading.append(
      element('span', label, 'text-xs text-subtle'),
      element('span', latest, 'text-sm font-semibold')
    )
    card.append(heading, sparkline(values, `${label} over the last 24 hours`))
    grid.append(card)
  }
  trends.append(grid)
  const tables = section(
    root,
    'Largest tables',
    'Many dead rows suggest the table needs vacuuming.'
  )
  tables.append(
    table(
      ['Table', 'Size', 'Rows', 'Dead rows', 'Seq / index scans'],
      (performance.tables ?? []).map((row) => [
        row.name,
        formatBytes(row.total_bytes),
        String(row.live_rows),
        String(row.dead_rows),
        `${row.seq_scans} / ${row.index_scans}`,
      ])
    )
  )
  const queries = section(
    root,
    'Slowest queries',
    'By total execution time since statistics were last reset (pg_stat_statements).'
  )
  if (!performance.top_queries)
    queries.append(
      element('p', 'pg_stat_statements is not enabled for this database.', 'text-sm text-subtle')
    )
  else
    queries.append(
      table(
        ['Query', 'Calls', 'Total', 'Average', 'Rows'],
        performance.top_queries.map((row) => [
          element('code', row.query, 'break-all text-xs'),
          String(row.calls),
          `${row.total_ms} ms`,
          `${row.mean_ms} ms`,
          String(row.rows),
        ])
      )
    )
}

function renderProjects() {
  $('projects').replaceChildren()
  for (const project of projects.values()) {
    const card = element('article', '', 'rounded-lg border border-border p-5')
    const title = element('h2', project.name, 'text-lg font-semibold')
    card.append(
      title,
      element('p', project.status, 'mt-2 text-sm text-subtle'),
      element('p', project.id, 'mt-4 break-all font-mono text-xs text-subtle'),
      element('p', `${project.memoryMb} MiB / ${project.cpus} CPU`, 'mb-5 mt-2 text-sm'),
      button('Manage project', async () => detail(await api(`/api/projects/${project.id}`)))
    )
    $('projects').append(card)
  }
}
async function loadProjects(reset = false) {
  if (reset) {
    projects.clear()
    nextCursor = ''
  }
  const page = await api(`/api/projects?limit=30&cursor=${nextCursor ?? ''}`)
  for (const project of page.projects) projects.set(project.id, project)
  nextCursor = page.nextCursor
  $('more').hidden = !nextCursor
  renderProjects()
}
for (const node of document.querySelectorAll('[data-close]'))
  node.addEventListener('click', () => node.closest('dialog').close())
// Drawers close when the backdrop (outside the panel) is clicked, like Escape.
for (const dialog of document.querySelectorAll('dialog'))
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return
    const box = dialog.getBoundingClientRect()
    const inside =
      event.clientX >= box.left &&
      event.clientX <= box.right &&
      event.clientY >= box.top &&
      event.clientY <= box.bottom
    if (!inside) dialog.close()
  })
$('detail-dialog').addEventListener('close', () => {
  selected = null
  $('detail').replaceChildren()
})
$('new-project').addEventListener('click', () => $('create-dialog').showModal())
$('more').addEventListener('click', () => loadProjects().catch((error) => notice(error.message)))
function submit(formId, action) {
  $(formId).addEventListener('submit', async (event) => {
    event.preventDefault()
    const form = event.currentTarget,
      control = form.querySelector('button[type="submit"]')
    control.disabled = true
    try {
      await action(Object.fromEntries(new FormData(form)))
      form.closest('dialog').close()
      form.reset()
    } catch (error) {
      notice(error.message)
    } finally {
      control.disabled = false
    }
  })
}
submit('create-form', async (values) => {
  await api('/api/projects', {
    method: 'POST',
    body: JSON.stringify({
      ...values,
      memoryMb: Number(values.memoryMb),
      cpus: Number(values.cpus),
    }),
  })
  notice('Project queued for provisioning.')
  await loadProjects(true)
})
submit('confirm-form', async (values) => confirmationAction(values.confirmation))
submit('access-form', async (values) => {
  await api('/api/members', { method: 'POST', body: JSON.stringify(values) })
  notice('Access updated. The member must sign in again.')
})
$('members').addEventListener('click', async () => {
  try {
    $('access-list').textContent = JSON.stringify(await api('/api/members'), null, 2)
    $('access-dialog').showModal()
  } catch (error) {
    notice(error.message)
  }
})
$('audit').addEventListener('click', async () => {
  try {
    $('detail-title').textContent = 'Audit log'
    $('detail').replaceChildren(
      element(
        'pre',
        JSON.stringify(await api('/api/audit'), null, 2),
        'overflow-auto whitespace-pre-wrap text-xs'
      )
    )
    $('detail-dialog').showModal()
  } catch (error) {
    notice(error.message)
  }
})
$('logout').addEventListener('click', async () => {
  try {
    await api('/auth/logout', { method: 'POST', body: '{}' })
    location.reload()
  } catch (error) {
    notice(error.message)
  }
})
try {
  me = await api('/api/me')
  $('identity').textContent = me.role
  $('login').hidden = true
  $('logout').hidden = false
  $('new-project').hidden = !['owner', 'operator'].includes(me.role)
  $('members').hidden = me.role !== 'owner'
  $('audit').hidden = me.role !== 'owner'
  await loadProjects()
  // Deep links from each project's Studio switcher: #new and #project/<id>.
  const [, linked] = location.hash.match(/^#project\/(p[a-f0-9]{24})$/) ?? []
  if (location.hash === '#new' && !$('new-project').hidden) $('create-dialog').showModal()
  else if (linked) {
    try {
      const project = projects.get(linked) ?? (await api(`/api/projects/${linked}`))
      await detail(project)
    } catch (error) {
      notice(error.message)
    }
  }
  if (location.hash) history.replaceState(null, '', location.pathname)
  setInterval(async () => {
    if (document.hidden || $('detail-dialog').open) return
    try {
      // Refresh loaded projects without discarding pagination or duplicating rows.
      for (const id of [...projects.keys()].slice(0, 30)) {
        try {
          projects.set(id, await api(`/api/projects/${id}`))
        } catch (error) {
          if (error.status === 404) projects.delete(id)
          else throw error
        }
      }
      renderProjects()
    } catch (error) {
      notice(error.message)
    }
  }, 15000)
} catch (error) {
  notice(
    error.message === 'Sign in to continue'
      ? 'Sign in with your platform identity to manage projects.'
      : error.message
  )
}
