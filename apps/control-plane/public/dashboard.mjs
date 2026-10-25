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
async function detail(project) {
  selected = project.id
  const root = $('detail')
  root.replaceChildren()
  $('detail-title').textContent = project.name
  const metadata = element('div', '', 'space-y-2 text-sm')
  for (const line of [
    `Project ID: ${project.id}`,
    `API URL: ${project.apiUrl}`,
    `Status: ${project.status}`,
    `Allocation: ${project.memoryMb} MiB / ${project.cpus} CPU`,
    `Last observed: ${project.lastObservedAt ?? 'Not observed yet'}`,
  ])
    metadata.append(element('p', line))
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
  if (!$('detail-dialog').open) $('detail-dialog').showModal()
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
