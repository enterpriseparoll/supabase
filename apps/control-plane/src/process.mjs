import { spawn } from 'node:child_process'

// argv is assembled only by the worker from validated IDs and approved templates.
// Errors intentionally omit subprocess output, which can contain credentials.
export async function command(
  program,
  args,
  { cwd, env = process.env, timeout = 600000, input, stdout } = {}
) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', stdout ?? 'pipe', 'pipe'],
    })
    const chunks = []
    let size = 0
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeout)
    child.stdout?.on('data', (chunk) => {
      size += chunk.length
      if (size <= 4 * 1024 * 1024) chunks.push(chunk)
    })
    child.stderr.on('data', () => {})
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(new Error(`COMMAND_${error.code ?? 'FAILED'}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut || code !== 0)
        return reject(new Error(timedOut ? 'COMMAND_TIMEOUT' : 'COMMAND_FAILED'))
      if (!stdout && size > 4 * 1024 * 1024) return reject(new Error('COMMAND_OUTPUT_LIMIT'))
      resolve(Buffer.concat(chunks).toString())
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}
