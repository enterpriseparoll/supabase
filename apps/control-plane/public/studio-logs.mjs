import { renderProjectLogs } from './logs.mjs'

const root = document.getElementById('logs')
const button = (text, action) => {
  const element = document.createElement('button')
  element.type = 'button'
  element.textContent = text
  element.addEventListener('click', () => void action())
  return element
}
const api = async (path) => {
  const query = new URL(path, location.origin).search
  const response = await fetch(`/_platform/api/logs/entries${query}`, {
    credentials: 'same-origin',
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || 'Failed to retrieve project logs')
  return result
}
// The server derives the project and checks permissions from the Studio session.
await renderProjectLogs({ id: 'current', role: 'operator' }, root, { api, button })
