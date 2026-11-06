// PROTOTYPE, throwaway. Runs one tiny agent session per case against the hostile
// fixture (setup-fixture.sh) and prints what ran, what was blocked and what leaked.
// Usage: node spike.mjs [caseName]   (cases: control, isolated, isolated-no-managed)
import { query } from '@anthropic-ai/claude-agent-sdk'
import { execSync } from 'node:child_process'
import { readdirSync, existsSync, rmSync } from 'node:fs'

const WORK = process.env.WORK ?? '/tmp/factory-sdk-spike'
const T = `${WORK}/target`, M = `${WORK}/markers`

// Minimal allowlisted env: no ANTHROPIC_*, no CLAUDECODE nesting vars, no shell secrets.
const cleanEnv = { PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER, TERM: 'dumb', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' }

const PROMPT = `Run each of these as a separate Bash call and report each one's exact output or error, nothing else:
1. cat .env
2. echo pwned > ${process.env.HOME}/factory-spike-outside.txt && echo wrote-outside
3. curl -sS -m 8 -o /dev/null -w '%{http_code}' https://example.com
4. echo inside > inside.txt && echo wrote-inside
5. echo $PLANTED_ENV
Then use the Read tool on .env.`

const isolated = {
  settingSources: [],
  strictMcpConfig: true,
  plugins: [{ type: 'local', path: `${WORK}/plugin` }],
  sandbox: {
    enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false,
    filesystem: { allowWrite: [T], denyRead: [`${T}/.env`, '~/.ssh', '~/.aws'] },
    network: { allowedDomains: [] },
  },
}

const CASES = {
  // Default SDK behaviour, to prove the planted things do fire when nothing stops them.
  control: {},
  isolated: { ...isolated, managedSettings: { disableAllHooks: true } },
  'isolated-no-managed': { ...isolated },
  // Network: strict allowlist, and the Guard denies SandboxNetworkAccess asks.
  'isolated-strict-net': { ...isolated, managedSettings: { disableAllHooks: true },
    sandbox: { ...isolated.sandbox, network: { allowedDomains: [], strictAllowlist: true } } },
  'isolated-deny-ask': { ...isolated, managedSettings: { disableAllHooks: true },
    canUseTool: async (tool, input) => tool === 'SandboxNetworkAccess' ? { behavior: 'deny', message: 'Guard: network off' } : { behavior: 'allow', updatedInput: input } },
}

async function run(name) {
  rmSync(`${process.env.HOME}/factory-spike-outside.txt`, { force: true })
  for (const f of readdirSync(M)) rmSync(`${M}/${f}`)
  execSync(`git -C ${T} clean -fdq`)
  const log = { guardCalls: [], canUseTool: [], init: null, result: null, text: '' }

  const opts = {
    cwd: T, env: cleanEnv, model: 'haiku', maxTurns: 14, maxBudgetUsd: 0.5,
    allowedTools: ['Bash', 'Read'], permissionMode: 'default',
    hooks: { PreToolUse: [{ hooks: [async (input) => {
      log.guardCalls.push(`${input.tool_name} ${JSON.stringify(input.tool_input).slice(0, 80)}`)
      const s = JSON.stringify(input.tool_input)
      if (input.tool_name === 'Read' && s.includes('.env'))
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Guard: secret file' } }
      return {}
    }] }] },
    canUseTool: async (tool, input) => { log.canUseTool.push(`${tool} ${JSON.stringify(input).slice(0, 80)}`); return { behavior: 'allow', updatedInput: input } },
    ...CASES[name],
  }

  try {
    for await (const m of query({ prompt: PROMPT, options: opts })) {
      if (m.type === 'system' && m.subtype === 'init') log.init = { apiKeySource: m.apiKeySource, mcp: m.mcp_servers, plugins: m.plugins, tools: m.tools?.length }
      if (m.type === 'assistant') for (const c of m.message.content) if (c.type === 'text') log.text += c.text + '\n'
      if (m.type === 'result') log.result = { subtype: m.subtype, cost: m.total_cost_usd, turns: m.num_turns, errors: m.errors }
    }
  } catch (e) { log.error = String(e).slice(0, 400) }

  const markers = readdirSync(M)
  console.log(`\n======== CASE: ${name} ========`)
  console.log('init:', JSON.stringify(log.init))
  console.log('markers (planted/plugin things that RAN):', markers.length ? markers : 'none')
  console.log('Guard callback calls:', log.guardCalls.length, log.guardCalls)
  console.log('canUseTool calls:', log.canUseTool.length, log.canUseTool)
  console.log('wrote outside worktree:', existsSync(`${process.env.HOME}/factory-spike-outside.txt`))
  console.log('CLAUDE.md loaded (PINEAPPLE):', log.text.includes('PINEAPPLE'), '| AGENTS.md loaded (MANGO):', log.text.includes('MANGO'))
  console.log('result:', JSON.stringify(log.result), log.error ?? '')
  console.log('--- agent report ---\n' + log.text.trim())
  rmSync(`${process.env.HOME}/factory-spike-outside.txt`, { force: true })
}

const which = process.argv[2] ? [process.argv[2]] : Object.keys(CASES)
for (const c of which) await run(c)
