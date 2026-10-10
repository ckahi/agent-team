// 归位：qa 产出（qa 任务 20f2d4a6），dev 于 fix 89774cba 移入 scripts/ 作为打包回归门禁。
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
const sandboxRequire = (id) => {
  required.push(id)
  if (HOST_MODULES.has(id)) return { fake: id }
  throw new Error(`Simulated frozen-module: cannot resolve external "${id}"`)
}

const source = fs.readFileSync('lib/client.js', 'utf8')
const sandbox = {
  window: { __ModuleLoader__: { load: (opts) => { sandbox.registered = opts } } },
  document: undefined,
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
try {
  vm.runInContext(source, sandbox, { filename: 'client.js' })
  const fn = new Function('require', 'module', 'exports', 'return (function(){' + '})()')
  // The registered factory needs executing: banner wraps factory(require){...}
  const factory = sandbox.registered && sandbox.registered.factory
  if (typeof factory !== 'function') { console.log('RESULT: no factory registered'); process.exit(1) }
  const mod = { exports: {} }
  factory(sandboxRequire, mod, mod.exports)
  console.log('RESULT: factory executed OK; externals required:', JSON.stringify(required))
} catch (error) {
  console.log('RESULT: factory FAILED ->', error.message)
  console.log('externals required so far:', JSON.stringify(required))
  process.exit(0)
}
