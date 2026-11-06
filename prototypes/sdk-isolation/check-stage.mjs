// PROTOTYPE, throwaway. Runs a hostile "verify command" (as a Check Stage would, with no
// agent involved) under @anthropic-ai/sandbox-runtime and prints what it could do.
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'

const WORK = process.env.WORK ?? '/tmp/factory-sdk-spike'
const T = `${WORK}/target`, OUT = `${process.env.HOME}/factory-spike-check-outside.txt`

// What `npm test` could do after an agent edited the test file.
const hostile = [
  'echo "secret check var: $CHECK_SECRET"',
  'cat .env || true',
  `ls ~/.ssh >/dev/null 2>&1 && echo "read ~/.ssh: yes" || echo "read ~/.ssh: no"`,
  `echo pwned > ${OUT} 2>/dev/null && echo "wrote outside: yes" || echo "wrote outside: no"`,
  'echo ok > check-artifact.txt && echo "wrote inside: yes"',
  `curl -sS -m 8 -o /dev/null -w "registry.npmjs.org %{http_code}\\n" https://registry.npmjs.org/ || true`,
  `curl -sS -m 8 -o /dev/null -w "example.com %{http_code}\\n" https://example.com/ || true`,
].join('; ')

await SandboxManager.initialize({
  network: { allowedDomains: ['registry.npmjs.org'], deniedDomains: [] },
  filesystem: { denyRead: ['~/.ssh', '~/.aws', `${T}/.env`], allowWrite: [T, '/private/tmp'], denyWrite: [] },
})
rmSync(OUT, { force: true })
const wrapped = await SandboxManager.wrapWithSandbox(hostile)
// Only the secret configured for this check is passed; nothing else from the Orchestrator's env.
// Must be async: the network proxy lives in this process, and spawnSync would block it.
const r = await new Promise((res) => {
  const c = spawn(wrapped, { shell: true, cwd: T, env: { PATH: process.env.PATH, HOME: process.env.HOME, CHECK_SECRET: 'only-this-one' } })
  let stdout = '', stderr = ''
  c.stdout.on('data', d => stdout += d); c.stderr.on('data', d => stderr += d)
  c.on('exit', status => res({ status, stdout, stderr }))
})
console.log('exit:', r.status)
console.log(r.stdout.trim())
console.log('stderr:', SandboxManager.annotateStderrWithSandboxFailures(hostile, r.stderr).trim().slice(0, 600))
console.log('outside file exists:', existsSync(OUT))
rmSync(OUT, { force: true })
await SandboxManager.reset()
