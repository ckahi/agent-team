import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const HOST = 'H:\\Program Files\\DSH Desktop\\resources\\app\\node_modules\\@deepseek-ai'
const storage = await import(pathToFileURL(join(HOST, 'dsh-storage', 'lib', 'index.js')).href)
const json = await import(pathToFileURL(join(HOST, 'dsh-storage-json', 'lib', 'index.js')).href)
const domain = await import(pathToFileURL(join(HOST, 'dsh-storage-domain', 'lib', 'index.js')).href)
const pluginDomain = await import(pathToFileURL('E:/thirdparty/dsh-plugins/agent-team/src/storage/domain.ts').href).catch(() => null)

const root = await mkdtemp(join(tmpdir(), 'qa-debug-'))
const registry = new storage.BackendRegistry()
registry.register('json', new json.JsonStorageBackend(root))
const facility = new domain.DomainFacility(
  { storage: { backend: registry }, logger: { error: (...a) => console.log('[host-logger.error]', ...a), warn: () => {}, info: () => {} } },
  { backend: 'json' },
)

// 用 legacy spec（single）写一份，看文件落哪
const legacy = await facility.open({
  name: 'agent_team', version: 1,
  tables: { teams: { valueSchema: { parse: v => v } } },
})
await legacy.table('teams').put('t1', { hello: 'world' })
await legacy.close()
console.log('--- after single-unit put, root listing:')
for (const f of await readdir(root, { withFileTypes: true })) console.log(' ', f.isDirectory() ? f.name + '/' : f.name)

// per-record spec 写一份，看布局
const runtime = await facility.open({
  name: 'agent_team_runtime', version: 1, layout: 'per-record',
  tables: { teams: { valueSchema: { parse: v => v } } },
})
await runtime.table('teams').put('tGood', { ok: 1 })
await runtime.close()
async function walk(dir, pre = '') {
  for (const f of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, f.name)
    if (f.isDirectory()) { console.log(pre + f.name + '/'); await walk(p, pre + '  ') }
    else console.log(pre + f.name, JSON.stringify((await readFile(p, 'utf8')).slice(0, 200)))
  }
}
console.log('--- per-record layout:')
await walk(root)

// 关键实验：schema-invalid 且索引内（直接篡改已索引文件）
console.log('--- experiment: corrupt the INDEXED team file, reopen:')
const files = []
async function collect(dir) {
  for (const f of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, f.name)
    if (f.isDirectory()) await collect(p); else files.push(p)
  }
}
await collect(join(root, 'agent_team_runtime'))
const teamFiles = files.filter(p => p.includes('tGood'))
console.log('tGood files:', teamFiles)
await writeFile(teamFiles[0], JSON.stringify({ version: 1, record: { schemaVersion: 1, id: 'tGood', totallyWrong: true } }), 'utf8')
try {
  const reopened = await facility.open({
    name: 'agent_team_runtime', version: 1, layout: 'per-record',
    tables: { teams: { valueSchema: { parse: v => { if (!v.ok) throw new Error('SIMULATED-SCHEMA-FAIL'); return v } } } },
  })
  console.log('reopen OK, teams =', [...reopened.table('teams').entries()])
  await reopened.close()
} catch (e) { console.log('reopen THREW:', e.code ?? '', String(e.message).slice(0, 160)) }

// 索引外野文件（之前 A5 场景）——是否根本不被读？
await writeFile(join(root, 'agent_team_runtime', 'teams', 'tWild.json'), JSON.stringify({ version: 1, record: { schemaVersion: 1, id: 'tWild', bad: true } }), 'utf8')
try {
  const reopened2 = await facility.open({
    name: 'agent_team_runtime', version: 1, layout: 'per-record',
    tables: { teams: { valueSchema: { parse: v => v } } },
  })
  console.log('wild-file reopen OK, team keys =', [...reopened2.table('teams').entries()].map(([k]) => k))
  await reopened2.close()
} catch (e) { console.log('wild-file reopen THREW:', e.code ?? '', String(e.message).slice(0, 120)) }
await rm(root, { recursive: true, force: true })
