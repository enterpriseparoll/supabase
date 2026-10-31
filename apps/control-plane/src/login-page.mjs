const bolt = `<svg class="h-full w-full" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M13.5 2 4 14h6l-1 8 9.5-12h-6l1-8z" /></svg>`

export const localLoginPage = (failed) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Sign in · Local project platform</title>
    <link rel="stylesheet" href="/styles.css" />
    <script type="module" src="/login.mjs"></script>
  </head>
  <body class="bg-background text-foreground font-sans antialiased">
    <div class="login-layout">
      <section class="login-main">
        <a class="login-brand" href="/" aria-label="Supabase platform">
          <span class="h-8 w-8 text-brand">${bolt}</span>
          <span>supabase<span class="ml-3 border-l border-border pl-3 text-sm font-normal text-subtle">Platform</span></span>
        </a>
        <main class="login-form-wrap">
          <span class="login-eyebrow"><span class="h-1.5 w-1.5 rounded-full bg-brand"></span> LOCAL WORKSPACE</span>
          <h1 class="mt-6 text-4xl font-semibold tracking-tight">Welcome back</h1>
          <p class="mt-3 text-sm leading-relaxed text-subtle">Sign in to manage your self-hosted projects.</p>
          <form id="login-form" method="post" action="/auth/local" class="mt-9 grid gap-5">
            ${failed ? '<div role="alert" class="rounded-lg border border-danger/30 bg-danger/5 p-3 text-sm text-danger">That token didn’t match. Copy it again from the logs and try again.</div>' : ''}
            <label for="login-token" class="grid gap-2.5 text-sm font-medium">Sign-in token
              <input id="login-token" name="token" type="password" autocomplete="off" required autofocus placeholder="Paste your sign-in token" class="h-12 font-mono text-sm" ${failed ? 'aria-invalid="true"' : ''} />
            </label>
            <button id="login-submit" type="submit" class="login-submit">
              <span>Sign in</span><span aria-hidden="true">→</span>
            </button>
          </form>
          <details class="login-help">
            <summary class="cursor-pointer text-sm text-subtle hover:text-foreground">Need your sign-in token?</summary>
            <p class="mt-4 text-xs leading-relaxed text-subtle">Run this command from <code>deploy/platform</code>, then copy the token from the output.</p>
            <pre class="mt-3 overflow-x-auto rounded-lg border border-border bg-surface p-3 text-xs leading-6"><code>docker compose -f compose.local.yml logs local-init</code></pre>
          </details>
          <div class="mt-8 flex items-center gap-2 text-xs text-subtle">
            <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>
            Access is limited to your local platform.
          </div>
        </main>
        <footer class="flex items-center justify-between gap-4 text-xs text-subtle">
          <span>Self-hosted. Built for you.</span>
          <a href="https://supabase.com/docs/guides/self-hosting" target="_blank" rel="noreferrer" class="hover:text-foreground">Documentation ↗</a>
        </footer>
      </section>
      <aside class="login-showcase" aria-label="About the platform">
        <div class="login-showcase-content">
          <span class="login-eyebrow text-brand">YOUR DEVELOPMENT WORKSPACE</span>
          <h2 class="mt-6 text-5xl font-medium leading-tight tracking-tight">Your projects.<br /><span class="text-subtle">Your infrastructure.</span></h2>
          <p class="mt-5 max-w-md text-sm leading-7 text-subtle">Everything you need to create, connect, and manage your Supabase projects in one place.</p>
          <div class="login-stack" aria-hidden="true">
            <div class="login-stack-heading"><span class="h-5 w-5 text-brand">${bolt}</span><span>Project workspace</span><span class="ml-auto text-xs text-subtle">localhost</span></div>
            <div class="login-stack-service"><span class="login-service-icon">01</span><div><strong>Database</strong><p>Postgres at the heart of every project</p></div><span class="ml-auto text-brand">↗</span></div>
            <div class="login-stack-service"><span class="login-service-icon">02</span><div><strong>Authentication</strong><p>A home for your users and sessions</p></div><span class="ml-auto text-brand">↗</span></div>
            <div class="login-stack-service"><span class="login-service-icon">03</span><div><strong>Storage &amp; APIs</strong><p>Connect your applications and files</p></div><span class="ml-auto text-brand">↗</span></div>
          </div>
          <p class="mt-7 text-xs text-subtle">One platform. A separate stack for every project.</p>
        </div>
        <span class="login-showcase-footer">POWERED BY OPEN SOURCE</span>
      </aside>
    </div>
  </body>
</html>`
