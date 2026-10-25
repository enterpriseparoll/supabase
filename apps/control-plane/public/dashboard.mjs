const $ = (id) => document.getElementById(id)
const projects = new Map()
const pendingOperations = new Map()
const trackedOperations = new Set()
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
let noticeTimer
function notice(message) {
  $('notice').textContent = message
  $('notice').hidden = !message
  clearTimeout(noticeTimer)
  if (message) noticeTimer = setTimeout(() => ($('notice').hidden = true), 8000)
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
      const controls = node.closest('[data-project-controls]')
      node.disabled = Boolean(controls && pendingOperations.has(controls.dataset.projectControls))
    }
  })
  return node
}
const operationLabels = {
  start: 'Resume',
  stop: 'Pause',
  restart: 'Restart',
  backup: 'Backup',
  restore: 'Restore',
  delete: 'Delete',
  resize: 'Resize',
  inspect: 'Refresh',
  deploy: 'Deploy',
}
const operationProgressLabels = {
  create: 'Creating project',
  start: 'Resuming project',
  stop: 'Pausing project',
  restart: 'Restarting project',
  backup: 'Backing up project',
  restore: 'Restoring project',
  delete: 'Deleting project',
  resize: 'Updating resources',
  inspect: 'Refreshing status',
  deploy: 'Deploying project',
}
function progressContainer(project, compact = false) {
  const container = element('div')
  container.dataset.operationProject = project.id
  container.dataset.compact = String(compact)
  container.setAttribute('role', 'status')
  container.setAttribute('aria-live', 'polite')
  return container
}
function updateOperationUI(projectId) {
  const pending = pendingOperations.get(projectId)
  for (const container of document.querySelectorAll('[data-operation-project]')) {
    if (container.dataset.operationProject !== projectId) continue
    container.hidden = !pending
    container.replaceChildren()
    if (!pending) continue
    const compact = container.dataset.compact === 'true'
    container.className = compact ? 'operation-progress-compact' : 'operation-progress'
    const label = operationProgressLabels[pending.kind] ?? 'Updating project'
    if (!compact) {
      const heading = element('div', '', 'flex items-center gap-2 font-medium text-sm')
      heading.append(element('span', '', 'operation-spinner'), element('span', `${label}…`))
      container.append(heading)
    }
    const description =
      pending.state === 'submitting'
        ? 'Sending your request…'
        : pending.state === 'queued'
          ? 'Request received. Waiting to start.'
          : 'This can take a few minutes. You can keep this page open.'
    container.append(element('p', description, 'text-xs text-subtle'))
    const bar = element('div', '', 'operation-track')
    bar.setAttribute('role', 'progressbar')
    bar.setAttribute('aria-label', label)
    bar.setAttribute('aria-valuetext', description)
    bar.append(element('span', '', 'operation-fill'))
    container.append(bar)
  }
  for (const container of document.querySelectorAll('[data-project-controls]')) {
    if (container.dataset.projectControls !== projectId) continue
    container.setAttribute('aria-busy', String(Boolean(pending)))
    for (const control of container.querySelectorAll('button')) {
      control.disabled = Boolean(pending)
      if (control.dataset.operationKind) {
        control.textContent =
          pending?.kind === control.dataset.operationKind
            ? `${operationProgressLabels[pending.kind] ?? 'Updating project'}…`
            : operationLabels[control.dataset.operationKind]
      }
    }
  }
}
function rememberProject(project) {
  projects.set(project.id, project)
  if (project.pendingOperation && !pendingOperations.has(project.id)) {
    pendingOperations.set(project.id, project.pendingOperation)
    void trackOperation(project, project.pendingOperation.id, project.pendingOperation.kind)
  }
}
async function operation(project, kind, extra = {}) {
  if (pendingOperations.has(project.id)) return
  pendingOperations.set(project.id, { kind, state: 'submitting' })
  renderProjects()
  updateOperationUI(project.id)
  try {
    const result = await api(`/api/projects/${project.id}/operations`, {
      method: 'POST',
      body: JSON.stringify({ kind, ...extra }),
    })
    pendingOperations.set(project.id, { id: result.id, kind, state: result.state })
    updateOperationUI(project.id)
    void trackOperation(project, result.id, kind)
    await loadProjects(true).catch(() => {})
  } catch (error) {
    pendingOperations.delete(project.id)
    updateOperationUI(project.id)
    renderProjects()
    throw error
  }
}
// Follows a queued operation until it finishes, then reports the result and refreshes
// the open project so its buttons and status match the new state.
async function trackOperation(project, id, kind) {
  if (trackedOperations.has(id)) return
  trackedOperations.add(id)
  const label = operationLabels[kind] ?? kind
  while (pendingOperations.get(project.id)?.id === id) {
    await new Promise((done) => setTimeout(done, 3000))
    let row
    try {
      row = (await api(`/api/projects/${project.id}/operations`)).find((op) => op.id === id)
    } catch {
      continue
    }
    if (!row) continue
    if (['queued', 'running'].includes(row.state)) {
      if (pendingOperations.get(project.id)?.state !== row.state) {
        pendingOperations.set(project.id, { id, kind, state: row.state })
        updateOperationUI(project.id)
      }
      continue
    }
    pendingOperations.delete(project.id)
    trackedOperations.delete(id)
    updateOperationUI(project.id)
    notice(
      row.state === 'succeeded'
        ? `${label} finished.`
        : `${label} failed (${row.error_code ?? 'unknown error'}). Check the worker logs for details.`
    )
    await loadProjects(true).catch(() => {})
    if (selected === project.id && $('detail-dialog').open)
      try {
        await detail(await api(`/api/projects/${project.id}`))
      } catch (error) {
        if (error.status === 404) $('detail-dialog').close()
      }
    return
  }
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
  form.dataset.projectControls = project.id
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
  GitHub: renderGithub,
  Developer: renderDeveloper,
}
let activeTab = 'Overview'
async function detail(project) {
  selected = project.id
  rememberProject(project)
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
  root.append(bar, progressContainer(project), panel)
  if (!$('detail-dialog').open) $('detail-dialog').showModal()
  try {
    await detailTabs[activeTab](project, panel)
  } catch (error) {
    if (selected === project.id) panel.append(element('p', error.message, 'text-sm'))
  }
  updateOperationUI(project.id)
}
async function renderOverview(project, root) {
  const metadata = element('div', '', 'space-y-2 text-sm')
  for (const line of [
    `Project ID: ${project.id}`,
    `API URL: ${project.apiUrl}`,
    `Status: ${project.status === 'stopped' ? 'paused' : project.status}`,
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
    actions.dataset.projectControls = project.id
    const isRunning = project.desiredState === 'running'
    // A paused project has no running Studio to open.
    if (isRunning) {
      actions.append(
        button('Connect', async () => {
          const ticket = await api(`/api/projects/${project.id}/studio-ticket?connect=true`, {
            method: 'POST',
            body: '{}',
          })
          location.assign(ticket.url)
        })
      )
      actions.append(
        button('Open Studio', async () => {
          const ticket = await api(`/api/projects/${project.id}/studio-ticket`, {
            method: 'POST',
            body: '{}',
          })
          location.assign(ticket.url)
        })
      )
    }
    // Paused projects keep their data; only the actions that apply are shown.
    const lifecycle = isRunning ? ['stop', 'restart'] : ['start']
    for (const kind of lifecycle) {
      const control = button(operationLabels[kind], () => operation(project, kind))
      control.dataset.operationKind = kind
      actions.append(control)
    }
    actions.append(button('Back up now', () => operation(project, 'backup')))
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

// ---- Shared helpers for developer sections ----
function codeBlock(text = '') {
  return element(
    'pre',
    text,
    'overflow-x-auto whitespace-pre-wrap break-all rounded bg-muted p-3 font-mono text-xs'
  )
}
function copyButton(read, label = 'Copy') {
  return button(label, async () => {
    try {
      await navigator.clipboard.writeText(read())
      notice('Copied to the clipboard.')
    } catch {
      notice('Copy failed. Select the text and copy it instead.')
    }
  })
}
function choice(label, options, value, onChange) {
  const wrapper = element('label', label, 'block text-sm')
  const select = document.createElement('select')
  select.className = 'mt-2'
  for (const [key, text] of options) select.append(new Option(text, key, false, key === value))
  select.addEventListener('change', () => onChange(select.value))
  wrapper.append(select)
  return wrapper
}
function row(...items) {
  const wrapper = element('div', '', 'flex flex-wrap items-center gap-2')
  wrapper.append(...items.filter(Boolean))
  return wrapper
}
function remember(key, fallback) {
  try {
    return localStorage.getItem(`platform.${key}`) ?? fallback
  } catch {
    return fallback
  }
}
function store(key, value) {
  try {
    localStorage.setItem(`platform.${key}`, value)
  } catch {
    /* preferences are optional */
  }
}
// Keys revealed in this page session only; never stored.
const revealedKeys = new Map()
let createdToken = null

// ---- Developer: app settings, Supabase CLI, AI agents ----
async function renderDeveloper(project, root) {
  const canReveal = ['owner', 'operator'].includes(project.role)
  const keys = revealedKeys.get(project.id)
  // A new button per section: one DOM node can only appear in one place.
  const reveal = () =>
    canReveal && !keys
      ? button('Show keys and password', async () => {
          revealedKeys.set(
            project.id,
            await api(`/api/projects/${project.id}/secrets`, { method: 'POST', body: '{}' })
          )
          detail(project)
        })
      : null

  const app = section(
    root,
    'Connect your app',
    "Add these to your app's environment file. The anon key is safe in browsers: Row Level Security protects your data."
  )
  const env = codeBlock()
  const framework = remember('framework', 'vite')
  const renderEnv = (value) => {
    const prefix = { vite: 'VITE_', next: 'NEXT_PUBLIC_', expo: 'EXPO_PUBLIC_', node: '' }[value]
    env.textContent = [
      `${prefix}SUPABASE_URL=${project.apiUrl}`,
      `${prefix}SUPABASE_ANON_KEY=${keys?.anonKey ?? '<select "Show keys and password">'}`,
      ...(keys?.publishableKey ? [`${prefix}SUPABASE_PUBLISHABLE_KEY=${keys.publishableKey}`] : []),
    ].join('\n')
  }
  renderEnv(framework)
  app.append(
    choice(
      'Framework',
      [
        ['vite', 'Vite (React, Vue, Svelte)'],
        ['next', 'Next.js'],
        ['expo', 'Expo / React Native'],
        ['node', 'Node.js or other'],
      ],
      framework,
      (value) => {
        store('framework', value)
        renderEnv(value)
      }
    ),
    env,
    row(
      copyButton(() => env.textContent),
      reveal()
    )
  )
  if (canReveal && !keys)
    app.append(element('p', 'Showing keys is recorded in the audit log.', 'text-xs text-subtle'))

  if (project.databaseUrl) {
    const cli = section(
      root,
      'Supabase CLI',
      'Run these in your app folder (the one containing supabase/migrations). They connect through this project\'s pooler, so they work with any CLI version. Commands marked "Docker" need Docker Desktop running.'
    )
    const shell = remember('shell', navigator.userAgent.includes('Windows') ? 'powershell' : 'bash')
    const list = element('div', '', 'space-y-3')
    const renderCli = (value) => {
      const url = keys
        ? project.databaseUrl.replace('[YOUR-PASSWORD]', encodeURIComponent(keys.databasePassword))
        : project.databaseUrl
      const variable = value === 'powershell' ? '$env:DB_URL' : '$DB_URL'
      const commands = [
        [
          'Point the CLI at this project (once per terminal)',
          value === 'powershell' ? `$env:DB_URL = "${url}"` : `export DB_URL="${url}"`,
        ],
        ['See which migrations are applied', `supabase migration list --db-url "${variable}"`],
        [
          'Apply new migrations from supabase/migrations',
          `supabase db push --db-url "${variable}"`,
        ],
        [
          'Apply migrations and seed.sql (new project)',
          `supabase db push --include-seed --db-url "${variable}"`,
        ],
        [
          'Turn changes made in Studio into a migration (Docker)',
          `supabase db pull --db-url "${variable}"`,
        ],
        [
          'Generate TypeScript types (Docker)',
          `supabase gen types typescript --db-url "${variable}" > src/types/database.types.ts`,
        ],
        ['Export the schema', `supabase db dump --db-url "${variable}" -f supabase/schema.sql`],
        ['Find slow queries', `supabase inspect db outliers --db-url "${variable}"`],
      ]
      list.replaceChildren()
      for (const [title, text] of commands) {
        const item = element('div', '', 'space-y-1')
        const code = codeBlock(text)
        code.classList.add('flex-1')
        const line = element('div', '', 'flex items-start gap-2')
        line.append(
          code,
          copyButton(() => code.textContent)
        )
        item.append(element('p', title, 'text-sm'), line)
        list.append(item)
      }
    }
    renderCli(shell)
    cli.append(
      choice(
        'Terminal',
        [
          ['powershell', 'PowerShell (Windows)'],
          ['bash', 'Bash or Zsh (macOS, Linux, WSL, Git Bash)'],
        ],
        shell,
        (value) => {
          store('shell', value)
          renderCli(value)
        }
      ),
      list,
      row(
        reveal(),
        button('Download TypeScript types', async () => {
          const response = await fetch(`/api/projects/${project.id}/types`, {
            credentials: 'same-origin',
          })
          if (!response.ok)
            throw new Error((await response.json()).error ?? 'Type generation failed')
          const link = document.createElement('a')
          link.href = URL.createObjectURL(await response.blob())
          link.download = 'database.types.ts'
          link.click()
          setTimeout(() => URL.revokeObjectURL(link.href), 60000)
        })
      ),
      element(
        'p',
        "Edge Functions: supabase functions deploy needs Supabase's cloud API. Deploy them from GitHub (GitHub tab) or with an AI agent (below).",
        'text-sm text-subtle'
      )
    )
  }

  const agents = section(
    root,
    'AI coding agents (MCP)',
    'Connect Claude Code, Cursor, VS Code, Windsurf, or any MCP client. Agents can list tables, run SQL, apply migrations, generate types, and deploy Edge Functions in this project.'
  )
  const client = remember('mcpClient', 'claude')
  const readOnlyBox = document.createElement('input')
  readOnlyBox.type = 'checkbox'
  readOnlyBox.checked = remember('mcpReadOnly', 'false') === 'true'
  const config = codeBlock()
  const hint = element('p', '', 'text-sm text-subtle')
  const renderAgent = (value) => {
    const url = `${me.mcpUrl}?project_id=${project.id}${readOnlyBox.checked ? '&read_only=true' : ''}`
    const token = createdToken ?? '<your-access-token>'
    const name = `supabase-${
      project.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || project.id
    }`
    const header = { Authorization: `Bearer ${token}` }
    const snippets = {
      claude: [
        `claude mcp add --transport http ${name} "${url}" --header "Authorization: Bearer ${token}"`,
        'Run in your app folder. Add --scope project to share it with your team (without the token, via an environment variable).',
      ],
      cursor: [
        JSON.stringify({ mcpServers: { [name]: { url, headers: header } } }, null, 2),
        'Save as .cursor/mcp.json in your app folder, then enable the server in Cursor Settings → MCP.',
      ],
      vscode: [
        JSON.stringify(
          {
            servers: {
              [name]: {
                type: 'http',
                url,
                headers: { Authorization: 'Bearer ${input:platform-token}' },
              },
            },
            inputs: [
              {
                type: 'promptString',
                id: 'platform-token',
                description: 'Supabase platform access token',
                password: true,
              },
            ],
          },
          null,
          2
        ),
        'Save as .vscode/mcp.json. VS Code asks for the token once and stores it securely.',
      ],
      windsurf: [
        JSON.stringify({ mcpServers: { [name]: { serverUrl: url, headers: header } } }, null, 2),
        'Add to ~/.codeium/windsurf/mcp_config.json.',
      ],
      other: [
        JSON.stringify(
          {
            mcpServers: {
              [name]: {
                command: 'npx',
                args: ['-y', 'mcp-remote', url, '--header', `Authorization: Bearer ${token}`],
              },
            },
          },
          null,
          2
        ),
        'For clients that only start local (stdio) servers, such as Claude Desktop: this bridges to the platform with mcp-remote.',
      ],
    }
    const [text, help] = snippets[value]
    config.textContent = text
    hint.textContent = help
  }
  const clientChoice = choice(
    'Client',
    [
      ['claude', 'Claude Code'],
      ['cursor', 'Cursor'],
      ['vscode', 'VS Code (Copilot)'],
      ['windsurf', 'Windsurf'],
      ['other', 'Claude Desktop or other (stdio)'],
    ],
    client,
    (value) => {
      store('mcpClient', value)
      renderAgent(value)
    }
  )
  readOnlyBox.addEventListener('change', () => {
    store('mcpReadOnly', String(readOnlyBox.checked))
    renderAgent(clientChoice.querySelector('select').value)
  })
  const readOnlyLabel = element('label', '', 'flex items-center gap-2 text-sm')
  readOnlyLabel.append(
    readOnlyBox,
    document.createTextNode('Read-only (agents can query but not change anything)')
  )
  renderAgent(client)
  agents.append(
    clientChoice,
    readOnlyLabel,
    config,
    hint,
    row(
      copyButton(() => config.textContent),
      createdToken ? null : button('Create an access token', () => openTokens())
    ),
    element(
      'p',
      createdToken
        ? 'Your new token is filled in above. It is shown only in this browser tab, so copy the configuration now.'
        : 'Replace <your-access-token> with a token from Access tokens. Agents act as you; read-only tokens can never change anything.',
      'text-xs text-subtle'
    )
  )
}

// ---- GitHub ----
async function renderGithub(project, root) {
  const status = await api(`/api/projects/${project.id}/github`)
  if (selected !== project.id) return
  const canOperate = ['owner', 'operator'].includes(project.role)
  const link = status.link
  if (!link || renderGithub.editing === project.id) {
    const wrapper = section(
      root,
      link ? 'Edit GitHub connection' : 'Connect a GitHub repository',
      'Each push to the branch applies new migrations from <folder>/migrations (recorded like supabase db push) and deploys Edge Functions from <folder>/functions.'
    )
    if (!canOperate) {
      wrapper.append(element('p', 'Owners and operators can connect a repository.', 'text-sm'))
      return
    }
    wrapper.append(githubForm(project, link))
    return
  }
  const summary = section(root, 'Connected repository')
  const repoLink = element('a', link.repository, 'underline')
  repoLink.href = `https://github.com/${link.repository}/tree/${encodeURIComponent(link.branch)}${link.directory ? `/${link.directory}` : ''}`
  repoLink.target = '_blank'
  repoLink.rel = 'noreferrer'
  const facts = element('div', '', 'space-y-1 text-sm')
  facts.append(row(element('span', 'Repository:'), repoLink))
  for (const line of [
    `Branch: ${link.branch}`,
    `Folder: ${link.directory || '(repository root)'}`,
    `Automatic deploys: ${link.autoDeploy ? `on, checked every ${link.hasToken ? 'minute' : '3 minutes (add a token to check every minute)'}` : 'off'}`,
    `Token: ${link.hasToken ? 'saved (encrypted)' : 'none (public repository)'}`,
    `Last checked: ${link.checkedAt ? formatTime(link.checkedAt) : 'not yet'}`,
  ])
    facts.append(element('p', line))
  if (link.checkError) facts.append(element('p', `GitHub: ${link.checkError}`, 'font-semibold'))
  summary.append(facts)
  if (canOperate)
    summary.append(
      row(
        button('Deploy now', () => operation(project, 'deploy')),
        button('Edit', () => {
          renderGithub.editing = project.id
          detail(project)
        }),
        button('Disconnect', async () => {
          await api(`/api/projects/${project.id}/github`, { method: 'DELETE', body: '{}' })
          notice('Repository disconnected. Deployed migrations and functions stay in place.')
          detail(project)
        })
      )
    )

  const history = section(root, 'Deployments')
  if (!status.deployments.length)
    history.append(
      element(
        'p',
        link.autoDeploy
          ? 'The first deployment starts after the next check.'
          : 'No deployments yet. Select Deploy now.',
        'text-sm text-subtle'
      )
    )
  else
    history.append(
      table(
        ['Started', 'Commit', 'Trigger', 'Result'],
        status.deployments.map((item) => {
          const commit = item.commit_sha
            ? Object.assign(element('a', item.commit_sha.slice(0, 7), 'font-mono underline'), {
                href: `https://github.com/${item.repository}/commit/${item.commit_sha}`,
                target: '_blank',
                rel: 'noreferrer',
              })
            : '—'
          const result = element('div', '', 'space-y-1')
          result.append(
            element(
              'p',
              item.state === 'succeeded'
                ? `Deployed: ${item.migrations.length} migration${item.migrations.length === 1 ? '' : 's'}, ${item.functions.length} function${item.functions.length === 1 ? '' : 's'}`
                : item.state === 'failed'
                  ? 'Failed'
                  : 'Running…',
              item.state === 'failed' ? 'font-semibold' : ''
            )
          )
          const notes = [
            ...(item.error ? [item.error] : []),
            ...(item.migrations.length ? [`Migrations: ${item.migrations.join(', ')}`] : []),
            ...(item.functions.length ? [`Functions: ${item.functions.join(', ')}`] : []),
            ...item.warnings,
          ]
          if (notes.length) {
            const more = element('details', '', 'text-xs')
            more.append(element('summary', 'Details'))
            for (const note of notes) more.append(element('p', note, 'mt-1 break-words'))
            result.append(more)
          }
          return [
            formatTime(item.created_at),
            commit,
            { push: 'Push', manual: 'Manual', provision: 'New project' }[item.source] ??
              item.source,
            result,
          ]
        })
      )
    )

  const share = section(
    root,
    'Deploy link for your README',
    'Opens Create project with this repository filled in, so anyone on this platform can start a copy in one click.'
  )
  const deployLink = `${location.origin}/#new?repo=${encodeURIComponent(link.repository)}&branch=${encodeURIComponent(link.branch)}&dir=${encodeURIComponent(link.directory)}`
  const markdown = codeBlock(`[Deploy to our Supabase](${deployLink})`)
  share.append(
    markdown,
    copyButton(() => markdown.textContent)
  )

  if (canOperate && !me.local) {
    const hook = section(
      root,
      'Instant deploys with a webhook',
      'Optional: GitHub can notify the platform on every push instead of waiting for the next check. In the repository, open Settings → Webhooks → Add webhook, use this URL with content type application/json, and paste the secret.'
    )
    const hookUrl = codeBlock(status.webhookUrl)
    hook.append(
      hookUrl,
      row(
        copyButton(() => hookUrl.textContent, 'Copy URL'),
        button('Show secret', async () => {
          const { secret } = await api(`/api/projects/${project.id}/github/webhook-secret`, {
            method: 'POST',
            body: '{}',
          })
          hook.append(codeBlock(secret))
        })
      )
    )
  }
}
function githubForm(project, link) {
  const form = element('form', '', 'space-y-4')
  const input = (label, name, value, attributes = {}) => {
    const wrapper = element('label', label, 'block text-sm')
    const field = document.createElement('input')
    Object.assign(field, { name, value: value ?? '', autocomplete: 'off', ...attributes })
    field.className = 'mt-2'
    wrapper.append(field)
    return wrapper
  }
  const grid = element('div', '', 'grid grid-cols-2 gap-4')
  grid.append(
    input('Branch', 'branch', link?.branch ?? 'main', { required: true }),
    input('Supabase folder', 'directory', link?.directory ?? 'supabase')
  )
  const auto = element('label', '', 'flex items-center gap-2 text-sm')
  const autoBox = Object.assign(document.createElement('input'), {
    type: 'checkbox',
    name: 'autoDeploy',
    checked: link?.autoDeploy ?? true,
  })
  auto.append(autoBox, document.createTextNode('Deploy automatically on every push'))
  form.append(
    input('Repository', 'repository', link?.repository ?? '', {
      required: true,
      placeholder: 'owner/name or https://github.com/owner/name',
    }),
    grid,
    input(
      link?.hasToken
        ? 'GitHub token (leave empty to keep the saved one)'
        : 'GitHub token (private repositories)',
      'token',
      '',
      { type: 'password', placeholder: 'github_pat_…' }
    ),
    element(
      'p',
      'Create a fine-grained token on GitHub (Settings → Developer settings) with read-only access to Contents for this repository. A token also lets the platform check for pushes every minute.',
      'text-xs text-subtle'
    ),
    auto
  )
  let clear
  if (link?.hasToken) {
    clear = Object.assign(document.createElement('input'), { type: 'checkbox', name: 'clearToken' })
    const label = element('label', '', 'flex items-center gap-2 text-sm')
    label.append(clear, document.createTextNode('Remove the saved token'))
    form.append(label)
  }
  const save = element('button', link ? 'Save' : 'Connect repository')
  save.type = 'submit'
  form.append(
    row(
      save,
      link
        ? button('Cancel', () => {
            renderGithub.editing = null
            detail(project)
          })
        : null
    )
  )
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const values = Object.fromEntries(new FormData(form))
    save.disabled = true
    try {
      await api(`/api/projects/${project.id}/github`, {
        method: 'POST',
        body: JSON.stringify({
          repository: values.repository,
          branch: values.branch,
          directory: values.directory,
          autoDeploy: autoBox.checked,
          ...(values.token ? { token: values.token } : {}),
          ...(clear?.checked ? { clearToken: true } : {}),
        }),
      })
      renderGithub.editing = null
      notice(
        autoBox.checked
          ? 'Repository connected. The latest commit deploys within a few minutes.'
          : 'Repository connected. Select Deploy now to deploy.'
      )
      detail(project)
    } catch (error) {
      notice(error.message)
    } finally {
      save.disabled = false
    }
  })
  return form
}

// ---- Access tokens ----
async function openTokens() {
  $('token-created').hidden = true
  await renderTokens()
  $('tokens-dialog').showModal()
}
async function renderTokens() {
  const tokens = await api('/api/access-tokens')
  const list = $('token-list')
  list.replaceChildren()
  if (!tokens.length) {
    list.append(element('p', 'No tokens yet.', 'text-sm text-subtle'))
    return
  }
  list.append(
    table(
      ['Name', 'Access', 'Last used', 'Expires', ''],
      tokens.map((item) => [
        item.name,
        item.readOnly ? 'Read-only' : 'Full',
        item.lastUsedAt ? formatTime(item.lastUsedAt) : 'Never',
        item.expiresAt ? formatTime(item.expiresAt) : 'Never',
        button('Revoke', async () => {
          await api(`/api/access-tokens/${item.id}`, { method: 'DELETE', body: '{}' })
          notice(`Revoked ${item.name}. Anything using it stops working now.`)
          await renderTokens()
        }),
      ])
    )
  )
}
$('tokens').addEventListener('click', () => openTokens().catch((error) => notice(error.message)))
$('token-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const form = event.currentTarget
  const control = form.querySelector('button[type="submit"]')
  const values = Object.fromEntries(new FormData(form))
  control.disabled = true
  try {
    const created = await api('/api/access-tokens', {
      method: 'POST',
      body: JSON.stringify({
        name: values.name,
        readOnly: values.readOnly === 'on',
        ...(values.expiresInDays ? { expiresInDays: Number(values.expiresInDays) } : {}),
      }),
    })
    createdToken = created.token
    const box = $('token-created')
    const code = codeBlock(created.token)
    box.replaceChildren(
      element(
        'p',
        `Copy “${created.name}” now. You won't be able to see it again.`,
        'text-sm font-semibold'
      ),
      code,
      copyButton(() => code.textContent)
    )
    box.hidden = false
    form.reset()
    await renderTokens()
  } catch (error) {
    notice(error.message)
  } finally {
    control.disabled = false
  }
})
$('tokens-dialog').addEventListener('close', () => {
  // Show the new token in the open project's MCP settings.
  if (selected && $('detail-dialog').open && projects.get(selected)) detail(projects.get(selected))
})

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

// ---- Project list: cloud-style cards, filtering, sorting, and layout ----
const iconPaths = {
  more: '<circle cx="12" cy="5.5" r="1.25"/><circle cx="12" cy="12" r="1.25"/><circle cx="12" cy="18.5" r="1.25"/>',
  pause:
    '<rect x="7" y="5" width="3.5" height="14" rx="1"/><rect x="13.5" y="5" width="3.5" height="14" rx="1"/>',
  dot: '<circle cx="12" cy="12" r="5"/>',
  clock:
    '<circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M12 7.5V12l3 2" fill="none" stroke="currentColor" stroke-width="1.5"/>',
}
function icon(name, classes = 'h-4 w-4') {
  const template = document.createElement('template')
  template.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" class="${classes}" aria-hidden="true">${iconPaths[name]}</svg>`
  return template.content.firstElementChild
}
const closeMenus = () => {
  for (const menu of document.querySelectorAll('.menu')) menu.remove()
}
const projectStatus = (project) => {
  const pending = pendingOperations.get(project.id)
  if (pending)
    return {
      key: 'provisioning',
      label: `${operationProgressLabels[pending.kind] ?? 'Updating project'}…`,
      icon: 'clock',
      tone: 'text-brand',
    }
  if (project.status === 'stopped')
    return { key: 'paused', label: 'Project is paused', icon: 'pause', tone: 'text-subtle' }
  if (project.status === 'ready')
    return { key: 'running', label: 'Project is running', icon: 'dot', tone: 'text-ok' }
  if (project.status === 'error')
    return { key: 'error', label: 'Something went wrong', icon: 'dot', tone: 'text-danger' }
  return {
    key: 'provisioning',
    label: 'Project is provisioning',
    icon: 'clock',
    tone: 'text-warning',
  }
}
const hostOf = (url) => {
  try {
    return new URL(url).host
  } catch {
    return url ?? ''
  }
}
const view = {
  q: '',
  status: 'all',
  sort: 'name',
  layout: localStorage.getItem('control-plane.layout') === 'list' ? 'list' : 'grid',
}
function visibleProjects() {
  let rows = [...projects.values()]
  const q = view.q.trim().toLowerCase()
  if (q)
    rows = rows.filter(
      (project) => project.name.toLowerCase().includes(q) || project.id.includes(q)
    )
  if (view.status !== 'all')
    rows = rows.filter((project) => projectStatus(project).key === view.status)
  if (view.sort === 'name') rows.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
  else
    rows.sort(
      (a, b) => (new Date(a.createdAt) - new Date(b.createdAt)) * (view.sort === 'oldest' ? 1 : -1)
    )
  return rows
}
// The "…" menu on each card mirrors the quick actions in the project drawer.
function cardMenu(project, card) {
  const canOperate = ['owner', 'operator'].includes(project.role)
  const running = project.desiredState === 'running' && project.status === 'ready'
  const items = []
  if (canOperate && running)
    items.push([
      'Open Studio',
      async () => {
        const ticket = await api(`/api/projects/${project.id}/studio-ticket`, {
          method: 'POST',
          body: '{}',
        })
        location.assign(ticket.url)
      },
    ])
  if (canOperate)
    items.push([
      running ? 'Pause project' : 'Resume project',
      () => operation(project, running ? 'stop' : 'start'),
    ])
  items.push(['Manage project', async () => detail(await api(`/api/projects/${project.id}`))])
  const kebab = element('button', '', 'kebab')
  kebab.type = 'button'
  kebab.append(icon('more'))
  kebab.setAttribute('aria-label', `Actions for ${project.name}`)
  kebab.setAttribute('aria-haspopup', 'menu')
  kebab.addEventListener('click', (event) => {
    event.stopPropagation()
    if (card.querySelector('.menu')) return closeMenus()
    closeMenus()
    const menu = element('div', '', 'menu')
    menu.setAttribute('role', 'menu')
    menu.addEventListener('click', (click) => click.stopPropagation())
    for (const [label, action] of items) {
      const item = button(label, async () => {
        menu.remove()
        await action()
      })
      item.className = 'menu-item'
      item.setAttribute('role', 'menuitem')
      if (label !== 'Manage project' && pendingOperations.has(project.id)) item.disabled = true
      menu.append(item)
    }
    card.append(menu)
  })
  return kebab
}
function openProject(card, project) {
  const open = () =>
    api(`/api/projects/${project.id}`)
      .then(detail)
      .catch((error) => notice(error.message))
  card.addEventListener('click', open)
  card.addEventListener('keydown', (event) => {
    if (event.target !== card || !['Enter', ' '].includes(event.key)) return
    event.preventDefault()
    open()
  })
}
function projectCard(project) {
  const state = projectStatus(project)
  const card = element('article', '', 'card')
  card.tabIndex = 0
  const head = element('div', '', 'flex items-start justify-between gap-3')
  head.append(element('h2', project.name, 'truncate font-medium'), cardMenu(project, card))
  card.append(head)
  card.append(element('p', hostOf(project.apiUrl), 'mt-0.5 truncate text-xs text-subtle'))
  const chips = element('div', '', 'mt-3 flex flex-wrap gap-1.5')
  chips.append(element('span', `${project.memoryMb} MiB / ${project.cpus} CPU`, 'chip'))
  if (project.release) chips.append(element('span', project.release, 'chip'))
  card.append(chips)
  const status = element('p', '', `mt-4 flex items-center gap-2 text-xs ${state.tone}`)
  status.append(icon(state.icon, 'h-3.5 w-3.5'), element('span', state.label))
  card.append(status)
  card.append(progressContainer(project, true))
  openProject(card, project)
  return card
}
function projectRow(project) {
  const state = projectStatus(project)
  const row = element('article', '', 'row-card')
  row.tabIndex = 0
  row.append(icon('dot', `h-2.5 w-2.5 shrink-0 ${state.tone}`))
  const main = element('div', '', 'min-w-0')
  main.append(
    element('h2', project.name, 'truncate text-sm font-medium'),
    element('p', hostOf(project.apiUrl), 'truncate text-xs text-subtle')
  )
  row.append(main)
  const right = element('div', '', 'ml-auto flex items-center gap-6')
  right.append(
    element('span', `${project.memoryMb} MiB / ${project.cpus} CPU`, 'chip hidden md:inline-flex'),
    element(
      'span',
      project.createdAt ? new Date(project.createdAt).toLocaleDateString() : '',
      'hidden text-xs text-subtle lg:inline'
    ),
    element('span', state.label, `hidden w-36 text-xs sm:inline ${state.tone}`),
    cardMenu(project, row)
  )
  row.append(right)
  row.append(progressContainer(project, true))
  openProject(row, project)
  return row
}
function meter(label, value, ratio) {
  const row = element('div')
  const top = element('div', '', 'flex items-baseline justify-between gap-2 text-xs')
  top.append(element('span', label, 'text-subtle'), element('span', value))
  row.append(top)
  if (ratio !== null) {
    const bar = element('div', '', 'meter')
    const fill = element('div', '', 'meter-fill')
    fill.style.width = `${Math.min(100, Math.max(0, ratio * 100))}%`
    bar.append(fill)
    row.append(bar)
  }
  return row
}
// ---- Usage panel and drill-through ----
// Like the usage card on Supabase Cloud: each figure opens a breakdown showing how
// much every project contributes. Totals cover all projects you can access.
let usage = null
let usageMetric = 'memory'
const mib = (value) => `${Math.round(value).toLocaleString()} MiB`
const cores = (value) => `${Number(value.toFixed(2)).toLocaleString()} CPU`
const count = (value) => Math.round(value).toLocaleString()
const usageMetrics = [
  {
    key: 'memory',
    label: 'Memory reserved',
    tab: 'Overview',
    format: mib,
    value: (p) => p.memoryMb,
    limit: (u) => u.capacity.memoryMb,
    limitLabel: 'host capacity',
    description:
      'Memory set aside for each project. A project can use up to its reservation; change it in the project’s Overview tab.',
  },
  {
    key: 'cpu',
    label: 'CPU reserved',
    tab: 'Overview',
    format: cores,
    value: (p) => p.cpus,
    limit: (u) => u.capacity.cpus,
    limitLabel: 'host capacity',
    description: 'CPU set aside for each project.',
  },
  {
    key: 'memoryUsed',
    label: 'Memory in use',
    tab: 'Overview',
    format: formatBytes,
    value: (p) => p.memoryUsedBytes,
    limit: (u) =>
      u.projects.filter((p) => p.running).reduce((sum, p) => sum + p.memoryMb * 1048576, 0),
    limitLabel: 'reserved by running projects',
    description:
      'Measured across each running project’s containers at the last check (about every minute).',
  },
  {
    key: 'cpuUsed',
    label: 'CPU in use',
    tab: 'Overview',
    format: cores,
    value: (p) => (p.cpuPercent === null ? null : p.cpuPercent / 100),
    limit: (u) => u.capacity.cpus,
    limitLabel: 'host capacity',
    description: 'CPU used by each running project’s containers at the last check.',
  },
  {
    key: 'database',
    label: 'Database size',
    tab: 'Performance',
    format: formatBytes,
    value: (p) => p.databaseBytes,
    description:
      'Size of each project’s Postgres database, collected every few minutes. The Performance tab shows the largest tables.',
  },
  {
    key: 'disk',
    label: 'Disk used',
    tab: 'Overview',
    format: formatBytes,
    value: (p) => p.diskBytes,
    limit: (u) =>
      u.capacity.hostAvailableBytes === null
        ? null
        : u.projects.reduce((sum, p) => sum + (p.diskBytes ?? 0), 0) +
          u.capacity.hostAvailableBytes,
    limitLabel: 'used plus free space on the host',
    description:
      'Everything each project stores on disk: database files, Storage files, and functions.',
  },
  {
    key: 'connections',
    label: 'Database connections',
    tab: 'Performance',
    format: count,
    value: (p) => p.connections,
    limit: (u) =>
      u.projects.filter((p) => p.running).reduce((sum, p) => sum + (p.maxConnections ?? 0), 0),
    limitLabel: 'allowed by running projects',
    description: 'Open connections to each project’s database at the last collection.',
  },
  {
    key: 'backups',
    label: 'Latest backup size',
    tab: 'Backups',
    format: formatBytes,
    value: (p) => p.lastBackupBytes,
    description: 'Size of each project’s most recent backup, before deduplication.',
  },
]
function usageTotals(metric) {
  const rows = usage.projects.map((project) => ({ project, value: metric.value(project) }))
  const measured = rows.filter((row) => row.value !== null && row.value !== undefined)
  const total = measured.reduce((sum, row) => sum + row.value, 0)
  const limit = metric.limit ? metric.limit(usage) : null
  return { rows, measured, total, limit: limit || null }
}
async function loadUsage() {
  try {
    usage = await api('/api/usage')
  } catch {
    return
  }
  renderUsage()
  if ($('usage-dialog').open) renderUsageDetail()
}
function renderUsage() {
  if (!me) return
  const panel = $('usage')
  if (!usage) {
    panel.replaceChildren(element('p', 'Loading usage…', 'text-xs text-subtle'))
    return
  }
  const items = []
  for (const metric of usageMetrics) {
    const { total, limit, measured } = usageTotals(metric)
    const value = measured.length
      ? `${metric.format(total)}${limit ? ` / ${metric.format(limit)}` : ''}`
      : 'Not measured yet'
    const item = element('button', '', 'usage-row')
    item.type = 'button'
    item.setAttribute('aria-label', `${metric.label}: ${value}. Show each project`)
    item.append(meter(metric.label, value, limit && measured.length ? total / limit : null))
    item.addEventListener('click', () => openUsage(metric.key))
    items.push(item)
  }
  const running = usage.projects.filter((p) => p.running).length
  const projectsItem = element('button', '', 'usage-row')
  projectsItem.type = 'button'
  projectsItem.append(
    meter(
      'Projects running',
      `${running} / ${usage.projects.length}`,
      usage.projects.length ? running / usage.projects.length : 0
    )
  )
  projectsItem.addEventListener('click', () => openUsage('memory'))
  items.push(projectsItem)
  panel.replaceChildren(...items)
}
function openUsage(key) {
  usageMetric = key
  renderUsageDetail()
  if (!$('usage-dialog').open) $('usage-dialog').showModal()
}
function renderUsageDetail() {
  const metric = usageMetrics.find((item) => item.key === usageMetric) ?? usageMetrics[0]
  const { rows, total, limit, measured } = usageTotals(metric)
  $('usage-dialog-title').textContent = metric.label
  const root = $('usage-detail')
  root.replaceChildren()
  const picker = element('div', '', 'flex flex-wrap gap-2 border-b border-border pb-3')
  picker.setAttribute('role', 'tablist')
  for (const item of usageMetrics) {
    const tab = element(
      'button',
      item.label,
      item.key === metric.key ? 'bg-muted font-semibold' : ''
    )
    tab.type = 'button'
    tab.setAttribute('role', 'tab')
    tab.setAttribute('aria-selected', String(item.key === metric.key))
    tab.addEventListener('click', () => openUsage(item.key))
    picker.append(tab)
  }
  root.append(picker)
  const summary = element('div', '', 'space-y-1')
  summary.append(
    element(
      'p',
      measured.length ? metric.format(total) : 'Not measured yet',
      'text-2xl font-semibold'
    ),
    element(
      'p',
      limit && measured.length
        ? `${Math.round((total / limit) * 100)}% of ${metric.format(limit)} ${metric.limitLabel}`
        : `Across ${usage.projects.length} project${usage.projects.length === 1 ? '' : 's'}`,
      'text-sm text-subtle'
    ),
    element('p', metric.description, 'text-sm text-subtle')
  )
  root.append(summary)
  const list = element('div', '', 'divide-y divide-border rounded-lg border border-border')
  const sorted = [...rows].sort((a, b) => (b.value ?? -1) - (a.value ?? -1))
  for (const { project, value } of sorted) {
    const share = value !== null && value !== undefined && total > 0 ? value / total : null
    const item = element('button', '', 'usage-project')
    item.type = 'button'
    const top = element('div', '', 'flex items-baseline justify-between gap-3')
    const name = element('div', '', 'min-w-0')
    name.append(
      element('p', project.name, 'truncate text-sm font-medium'),
      element(
        'p',
        !project.running
          ? 'Paused'
          : ({ ready: 'Running', error: 'Something went wrong' }[project.status] ?? 'Starting'),
        `text-xs ${project.status === 'error' ? 'text-danger' : 'text-subtle'}`
      )
    )
    const figure = element('div', '', 'shrink-0 text-right')
    figure.append(
      element(
        'p',
        value === null || value === undefined ? 'Not measured yet' : metric.format(value),
        'text-sm'
      ),
      element(
        'p',
        share === null ? '' : `${Math.round(share * 100)}% of total`,
        'text-xs text-subtle'
      )
    )
    top.append(name, figure)
    item.append(top)
    if (share !== null) {
      const bar = element('div', '', 'meter mt-2')
      const fill = element('div', '', 'meter-fill')
      fill.style.width = `${Math.max(1, share * 100)}%`
      bar.append(fill)
      item.append(bar)
    }
    item.title = `Open ${project.name} (${metric.tab})`
    item.addEventListener('click', async () => {
      try {
        const full = await api(`/api/projects/${project.id}`)
        $('usage-dialog').close()
        activeTab = metric.tab
        await detail(full)
      } catch (error) {
        notice(error.message)
      }
    })
    list.append(item)
  }
  if (!rows.length) list.append(element('p', 'No projects yet.', 'p-4 text-sm text-subtle'))
  root.append(list)
  const observed = usage.projects
    .map((p) => (metric.tab === 'Performance' ? p.insightsAt : p.observedAt))
    .filter(Boolean)
    .sort()
    .at(-1)
  root.append(
    element(
      'p',
      `${observed ? `Last measured ${formatTime(observed)}. ` : ''}Select a project to open it.`,
      'text-xs text-subtle'
    )
  )
}
function renderProjects() {
  const rows = visibleProjects()
  const grid = $('projects')
  grid.className =
    view.layout === 'grid'
      ? 'mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-3'
      : 'mt-5 divide-y divide-border overflow-hidden rounded-lg border border-border'
  grid.replaceChildren()
  for (const project of rows)
    grid.append(view.layout === 'grid' ? projectCard(project) : projectRow(project))
  const empty = $('projects-empty')
  empty.hidden = rows.length > 0
  if (!rows.length)
    empty.textContent = projects.size
      ? 'No projects match the current search or filters.'
      : 'No projects yet.'
  renderUsage()
  for (const id of projects.keys()) updateOperationUI(id)
}
async function loadProjects(reset = false) {
  if (reset) {
    projects.clear()
    nextCursor = ''
  }
  const page = await api(`/api/projects?limit=30&cursor=${nextCursor ?? ''}`)
  for (const project of page.projects) rememberProject(project)
  nextCursor = page.nextCursor
  $('more').hidden = !nextCursor
  renderProjects()
  loadUsage()
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
$('project-search').addEventListener('input', (event) => {
  view.q = event.target.value
  renderProjects()
})
$('status-filter').addEventListener('change', (event) => {
  view.status = event.target.value
  renderProjects()
})
$('sort-order').addEventListener('change', (event) => {
  view.sort = event.target.value
  renderProjects()
})
const setLayout = (layout) => {
  view.layout = layout
  localStorage.setItem('control-plane.layout', layout)
  $('view-grid').setAttribute('aria-pressed', String(layout === 'grid'))
  $('view-list').setAttribute('aria-pressed', String(layout === 'list'))
  renderProjects()
}
$('view-grid').addEventListener('click', () => setLayout('grid'))
$('view-list').addEventListener('click', () => setLayout('list'))
$('view-grid').setAttribute('aria-pressed', String(view.layout === 'grid'))
$('view-list').setAttribute('aria-pressed', String(view.layout === 'list'))
document.addEventListener('click', closeMenus)
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeMenus()
})
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
  const { githubRepository, githubBranch, githubDirectory, githubToken, ...fields } = values
  await api('/api/projects', {
    method: 'POST',
    body: JSON.stringify({
      ...fields,
      memoryMb: Number(values.memoryMb),
      cpus: Number(values.cpus),
      ...(githubRepository.trim()
        ? {
            github: {
              repository: githubRepository,
              branch: githubBranch,
              directory: githubDirectory,
              ...(githubToken ? { token: githubToken } : {}),
            },
          }
        : {}),
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
  $('identity').hidden = false
  $('login').hidden = true
  $('logout').hidden = false
  $('new-project').hidden = !['owner', 'operator'].includes(me.role)
  $('members').hidden = me.role !== 'owner'
  $('audit').hidden = me.role !== 'owner'
  $('tokens').hidden = false
  await loadProjects()
  // Deep links: #new and #project/<id> from Studio's switcher, and
  // #new?repo=owner/name&branch=main&dir=supabase from a README deploy link.
  const [, linked] = location.hash.match(/^#project\/(p[a-f0-9]{24})$/) ?? []
  if (location.hash.startsWith('#new') && !$('new-project').hidden) {
    const query = new URLSearchParams(location.hash.split('?')[1] ?? '')
    const form = $('create-form')
    if (query.get('repo')) {
      form.elements.githubRepository.value = query.get('repo')
      form.elements.name.value = query.get('repo').split('/').pop()
    }
    if (query.get('branch')) form.elements.githubBranch.value = query.get('branch')
    if (query.get('dir') !== null) form.elements.githubDirectory.value = query.get('dir')
    $('create-dialog').showModal()
  } else if (linked) {
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
          rememberProject(await api(`/api/projects/${id}`))
        } catch (error) {
          if (error.status === 404) projects.delete(id)
          else throw error
        }
      }
      renderProjects()
      await loadUsage()
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
