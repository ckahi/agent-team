// 归位：qa 产出（qa 任务 20f2d4a6），dev 于 fix 89774cba 移入 scripts/ 作为打包回归门禁。
// diag 9d369602 扩展：断言 client bundle 激活链路取证标记（[agent-team-boot] 双通道）。
// QA smoke: load lib/client.js in a simulated frozen-module environment.
// Host module table only provides what dsh-web-frontend rM() maps (react, jsx-runtime,
// react-dom, cordis, client-store, slots, dockkit, primitives).
const fs = require('node:fs')
const vm = require('node:vm')

const HOST_MODULES = new Set([
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-dockkit',
  '@deepseek-ai/dsh-client-ui-primitives',
])

const required = []
const bootLogs = []
const sandboxRequire = (id) => {
  required.push(id)
  if (HOST_MODULES.has(id)) return { fake: id }
  throw new Error(`Simulated frozen-module: cannot resolve external "${id}"`)
}

const source = fs.readFileSync('lib/client.js', 'utf8')
const sandbox = {
  window: { __ModuleLoader__: { load: (opts) => { sandbox.registered = opts } } },
  document: undefined,
  performance: { now: () => 0 },
  console: { log: (...args) => { bootLogs.push(args.join(' ')) } },
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
try {
  vm.runInContext(source, sandbox, { filename: 'client.js' })
  // The registered factory needs executing: banner wraps factory(require){...}
  const factory = sandbox.registered && sandbox.registered.factory
  if (typeof factory !== 'function') { console.log('RESULT: no factory registered'); process.exit(1) }
  const mod = { exports: {} }
  const bundleExports = factory(sandboxRequire, mod, mod.exports) ?? mod.exports
  console.log('RESULT: factory executed OK; externals required:', JSON.stringify(required))

  // Activation-chain forensic markers: factory eval -> apply -> slot callbacks -> done.
  const exports = bundleExports
  if (typeof exports.apply !== 'function') {
    console.log('RESULT: exports.apply is not a function')
    process.exit(1)
  }
  const fakeCtx = {
    slots: {
      // Simulate the host invoking the registration callback it receives.
      inject: (_name, setup) => { if (typeof setup === 'function') setup() },
      register: () => {},
    },
    workspaces: { create: async () => ({ workspaceId: 'w', path: 'p', title: 't' }) },
  }
  exports.apply(fakeCtx)
  const bootLog = sandbox.window.__AT_BOOT_LOG
  const stages = [
    'module-evaluated',
    'components-module-evaluated',
    'apply-begin',
    'slots-invoke:settings.section',
    'slots-invoke:shell.overlay',
    'apply-done',
  ]
  const missing = stages.filter(stage => !bootLogs.some(line => line.includes(`[agent-team-boot] ${stage}`)))
  if (missing.length > 0) {
    console.log('RESULT: boot markers missing ->', JSON.stringify(missing))
    console.log('boot logs captured:', JSON.stringify(bootLogs))
    process.exit(1)
  }
  if (!Array.isArray(bootLog) || bootLog.length === 0
    || bootLog.some(entry => typeof entry.stage !== 'string' || typeof entry.t !== 'number')) {
    console.log('RESULT: window.__AT_BOOT_LOG dual-channel invalid ->', JSON.stringify(bootLog))
    process.exit(1)
  }
  console.log('RESULT: boot markers OK:', JSON.stringify(stages), '; __AT_BOOT_LOG entries:', bootLog.length)
} catch (error) {
  console.log('RESULT: factory FAILED ->', error.message)
  console.log('externals required so far:', JSON.stringify(required))
  process.exit(0)
}
