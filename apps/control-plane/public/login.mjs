const form = document.getElementById('login-form')
form.addEventListener('submit', () => {
  form.setAttribute('aria-busy', 'true')
  const button = document.getElementById('login-submit')
  button.disabled = true
  button.firstElementChild.textContent = 'Signing in…'
})
// Browsers can restore the disabled submit button when navigating back.
window.addEventListener('pageshow', () => {
  form.removeAttribute('aria-busy')
  const button = document.getElementById('login-submit')
  button.disabled = false
  button.firstElementChild.textContent = 'Sign in'
})
