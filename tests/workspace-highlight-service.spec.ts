import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type { TeamAggregate } from '../src/domain/types.js'
import type { AgentTeamStore } from '../src/storage/store.js'
import { WorkspaceService } from '../src/service/workspace-service.js'

const temporaryDirectories: string[] = []
const PREVIEW_LIMIT = 1_048_576

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function createService(root: string): Promise<WorkspaceService> {
  const team = { id: 'team-1', workspaceId: 'workspace-1', workspacePath: root } as TeamAggregate
  const store = { getTeam: () => team, listTeams: () => [] } as unknown as AgentTeamStore
  const ctx = {
    workspaceRegistry: {
      get: () => ({ path: root, status: async () => 'ok' }),
    },
  } as unknown as Context
  const service = new WorkspaceService(ctx, store, () => {}, () => {})
  service.watch('team-1', root)
  return service
}

describe('WorkspaceService highlight', () => {
  it('正常-代码文件返回非空高亮 HTML', async () => {
    const root = await mkdtemp(join(tmpdir(), 'at-highlight-'))
    temporaryDirectories.push(root)
    await writeFile(join(root, 'main.ts'), 'const x = 1\n')
    const view = await createService(root).then(service => service.highlight('team-1', 'main.ts', 'dark'))
    expect(view.path).toBe('main.ts')
    expect(view.theme).toBe('dark')
    expect(view.html.length).toBeGreaterThan(0)
  })

  it('边界-未收录扩展名返回空 HTML', async () => {
    const root = await mkdtemp(join(tmpdir(), 'at-highlight-'))
    temporaryDirectories.push(root)
    await writeFile(join(root, 'notes.txt'), 'plain\n')
    const view = await createService(root).then(service => service.highlight('team-1', 'notes.txt', 'light'))
    expect(view.html).toBe('')
  })

  it('边界-超大文件（>1MB）返回空 HTML 而非渲染', async () => {
    const root = await mkdtemp(join(tmpdir(), 'at-highlight-'))
    temporaryDirectories.push(root)
    await writeFile(join(root, 'big.ts'), 'const a = 1\n'.repeat(100_000))
    const view = await createService(root).then(service => service.highlight('team-1', 'big.ts', 'light'))
    expect(view.html).toBe('')
  }, 20_000)

  it('边界-二进制内容返回空 HTML', async () => {
    const root = await mkdtemp(join(tmpdir(), 'at-highlight-'))
    temporaryDirectories.push(root)
    await writeFile(join(root, 'fake.ts'), Buffer.from([0x63, 0x00, 0x6f, 0x64, 0x65]))
    const view = await createService(root).then(service => service.highlight('team-1', 'fake.ts', 'light'))
    expect(view.html).toBe('')
  })

  it('安全-目录路径按 INVALID_REQUEST 拒绝', async () => {
    const root = await mkdtemp(join(tmpdir(), 'at-highlight-'))
    temporaryDirectories.push(root)
    await mkdir(join(root, 'folder.ts'))
    await expect(createService(root).then(service => service.highlight('team-1', 'folder.ts', 'light')))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('安全-不存在的文件按 INVALID_REQUEST 拒绝', async () => {
    const root = await mkdtemp(join(tmpdir(), 'at-highlight-'))
    temporaryDirectories.push(root)
    await expect(createService(root).then(service => service.highlight('team-1', 'missing.ts', 'light')))
      .rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('边界-PREVIEW 上限恰好 1MB 仍渲染（无额外阈值）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'at-highlight-'))
    temporaryDirectories.push(root)
    await writeFile(join(root, 'exact.ts'), `${'const a = 1\n'.repeat(60_000)}`.slice(0, PREVIEW_LIMIT).padEnd(PREVIEW_LIMIT, ' '))
    const view = await createService(root).then(service => service.highlight('team-1', 'exact.ts', 'light'))
    expect(view.html.length).toBeGreaterThan(0)
  }, 30_000)
})
