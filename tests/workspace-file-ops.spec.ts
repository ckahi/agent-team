import { afterEach, describe, expect, it } from 'vitest'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { platform } from 'node:process'
import type { Context } from '@deepseek-ai/cordis'
import { AgentTeamError } from '../src/domain/errors.js'
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

async function createSymlink(target: string, linkPath: string): Promise<boolean> {
  try {
    await symlink(target, linkPath)
    return true
  } catch {
    return false
  }
}

function expectInvalidRequest(error: unknown): void {
  expect(error).toBeInstanceOf(AgentTeamError)
  expect((error as AgentTeamError).code).toBe('INVALID_REQUEST')
}

describe('WorkspaceService read', () => {
  const cases: Array<{
    name: string
    setup: (root: string) => Promise<void>
    path: string
    verify: (root: string, service: WorkspaceService) => Promise<void>
  }> = [
    {
      name: '正常-文本文件返回内容与元数据',
      setup: async root => { await writeFile(join(root, 'notes.txt'), 'hello workspace') },
      path: 'notes.txt',
      verify: async (_root, service) => {
        await expect(service.read('team-1', 'notes.txt')).resolves.toEqual({
          path: 'notes.txt',
          bytes: 15,
          kind: 'text',
          oversize: false,
          content: 'hello workspace',
        })
      },
    },
    {
      name: '边界-空文件返回空内容而非无反馈',
      setup: async root => { await writeFile(join(root, 'empty.txt'), '') },
      path: 'empty.txt',
      verify: async (_root, service) => {
        const view = await service.read('team-1', 'empty.txt')
        expect(view).toMatchObject({ kind: 'text', oversize: false, content: '' })
      },
    },
    {
      name: '边界-恰好 1MB 正常返回',
      setup: async root => {
        await writeFile(join(root, 'big.txt'), 'a'.repeat(PREVIEW_LIMIT))
      },
      path: 'big.txt',
      verify: async (_root, service) => {
        const view = await service.read('team-1', 'big.txt')
        expect(view.oversize).toBe(false)
        expect(view.bytes).toBe(PREVIEW_LIMIT)
        expect(view.content?.length).toBe(PREVIEW_LIMIT)
      },
    },
    {
      name: '边界-超 1MB 返回超限降级且不回传内容',
      setup: async root => {
        await writeFile(join(root, 'huge.txt'), 'a'.repeat(PREVIEW_LIMIT + 1))
      },
      path: 'huge.txt',
      verify: async (_root, service) => {
        const view = await service.read('team-1', 'huge.txt')
        expect(view.oversize).toBe(true)
        expect(view.content).toBeUndefined()
        expect(view.bytes).toBe(PREVIEW_LIMIT + 1)
      },
    },
    {
      name: '异常-含 NUL 的二进制文件返回 binary 降级',
      setup: async root => {
        await writeFile(join(root, 'data.bin'), Buffer.from([0x62, 0x00, 0x62, 0x62]))
      },
      path: 'data.bin',
      verify: async (_root, service) => {
        const view = await service.read('team-1', 'data.bin')
        expect(view.kind).toBe('binary')
        expect(view.content).toBeUndefined()
      },
    },
    {
      name: '异常-绝对路径拒绝',
      setup: async () => {},
      path: join(tmpdir(), 'escape.txt'),
      verify: async (_root, service) => {
        await expect(service.read('team-1', join(tmpdir(), 'escape.txt'))).rejects.toThrow(AgentTeamError)
        try {
          await service.read('team-1', join(tmpdir(), 'escape.txt'))
        } catch (error) {
          expectInvalidRequest(error)
        }
      },
    },
    {
      name: '异常-.. 路径逃逸拒绝',
      setup: async () => {},
      path: '../outside.txt',
      verify: async (_root, service) => {
        try {
          await service.read('team-1', '../outside.txt')
          expect.unreachable('should have thrown')
        } catch (error) {
          expectInvalidRequest(error)
        }
      },
    },
    {
      name: '异常-目录拒绝预览',
      setup: async root => { await mkdir(join(root, 'folder'), { recursive: true }) },
      path: 'folder',
      verify: async (_root, service) => {
        try {
          await service.read('team-1', 'folder')
          expect.unreachable('should have thrown')
        } catch (error) {
          expectInvalidRequest(error)
        }
      },
    },
    {
      name: '异常-文件不存在返回明确错误',
      setup: async () => {},
      path: 'missing.txt',
      verify: async (_root, service) => {
        try {
          await service.read('team-1', 'missing.txt')
          expect.unreachable('should have thrown')
        } catch (error) {
          expectInvalidRequest(error)
        }
      },
    },
  ]

  for (const testCase of cases) {
    it(testCase.name, async () => {
      const root = await mkdtemp(join(tmpdir(), 'agent-team-workspace-read-'))
      temporaryDirectories.push(root)
      await testCase.setup(root)
      const service = await createService(root)
      try {
        await testCase.verify(root, service)
      } finally {
        await service.dispose()
      }
    })
  }

  it('边界-工作区内 symlink 按解析目标读取', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-team-workspace-read-'))
    temporaryDirectories.push(root)
    await writeFile(join(root, 'real.txt'), 'linked content')
    if (!await createSymlink(join(root, 'real.txt'), join(root, 'link.txt'))) {
      console.warn('symlink unavailable on this environment; skipped')
      return
    }
    const service = await createService(root)
    try {
      await expect(service.read('team-1', 'link.txt')).resolves.toMatchObject({
        kind: 'text',
        content: 'linked content',
      })
    } finally {
      await service.dispose()
    }
  })

  it('异常-symlink 指向工作区外拒绝', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-team-workspace-read-'))
    temporaryDirectories.push(root)
    const outside = await mkdtemp(join(tmpdir(), 'agent-team-workspace-outside-'))
    temporaryDirectories.push(outside)
    const outsideFile = join(outside, 'secret.txt')
    await writeFile(outsideFile, 'secret')
    if (!await createSymlink(outsideFile, join(root, 'evil.txt'))) {
      console.warn('symlink unavailable on this environment; skipped')
      return
    }
    const service = await createService(root)
    try {
      try {
        await service.read('team-1', 'evil.txt')
        expect.unreachable('should have thrown')
      } catch (error) {
        expectInvalidRequest(error)
      }
    } finally {
      await service.dispose()
    }
  })
})

describe('WorkspaceService delete', () => {
  it('正常-删除普通文件', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-team-workspace-delete-'))
    temporaryDirectories.push(root)
    await writeFile(join(root, 'gone.txt'), 'bye')
    const service = await createService(root)
    try {
      await expect(service.deleteFile('team-1', 'gone.txt')).resolves.toEqual({
        path: 'gone.txt',
        deleted: true,
        alreadyAbsent: false,
      })
    } finally {
      await service.dispose()
    }
  })

  it('正常-删除 symlink 仅移除链接本身不动目标（AC-15）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-team-workspace-delete-'))
    temporaryDirectories.push(root)
    await writeFile(join(root, 'target.txt'), 'still here')
    if (!await createSymlink(join(root, 'target.txt'), join(root, 'link.txt'))) {
      console.warn('symlink unavailable on this environment; skipped')
      return
    }
    const service = await createService(root)
    try {
      await expect(service.deleteFile('team-1', 'link.txt')).resolves.toEqual({
        path: 'link.txt',
        deleted: true,
        alreadyAbsent: false,
      })
      await expect(readFile(join(root, 'target.txt'), 'utf8')).resolves.toBe('still here')
    } finally {
      await service.dispose()
    }
  })

  it('异常-目录拒绝删除（P0-3）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-team-workspace-delete-'))
    temporaryDirectories.push(root)
    await mkdir(join(root, 'folder'), { recursive: true })
    const service = await createService(root)
    try {
      try {
        await service.deleteFile('team-1', 'folder')
        expect.unreachable('should have thrown')
      } catch (error) {
        expectInvalidRequest(error)
      }
    } finally {
      await service.dispose()
    }
  })

  it('边界-目标不存在返回幂等 alreadyAbsent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-team-workspace-delete-'))
    temporaryDirectories.push(root)
    const service = await createService(root)
    try {
      await expect(service.deleteFile('team-1', 'missing.txt')).resolves.toEqual({
        path: 'missing.txt',
        deleted: false,
        alreadyAbsent: true,
      })
    } finally {
      await service.dispose()
    }
  })

  it('边界-重复删除第二次 alreadyAbsent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-team-workspace-delete-'))
    temporaryDirectories.push(root)
    await writeFile(join(root, 'twice.txt'), 'x')
    const service = await createService(root)
    try {
      await expect(service.deleteFile('team-1', 'twice.txt')).resolves.toMatchObject({ deleted: true })
      await expect(service.deleteFile('team-1', 'twice.txt')).resolves.toEqual({
        path: 'twice.txt',
        deleted: false,
        alreadyAbsent: true,
      })
    } finally {
      await service.dispose()
    }
  })

  it('异常-路径逃逸拒绝且外部文件不受影响', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-team-workspace-delete-'))
    temporaryDirectories.push(root)
    const outside = await mkdtemp(join(tmpdir(), 'agent-team-workspace-outside-'))
    temporaryDirectories.push(outside)
    await writeFile(join(outside, 'precious.txt'), 'keep')
    const service = await createService(root)
    try {
      try {
        await service.deleteFile('team-1', '../precious.txt')
        expect.unreachable('should have thrown')
      } catch (error) {
        expectInvalidRequest(error)
      }
      await expect(readFile(join(outside, 'precious.txt'), 'utf8')).resolves.toBe('keep')
    } finally {
      await service.dispose()
    }
  })

  it('异常-绝对路径拒绝', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-team-workspace-delete-'))
    temporaryDirectories.push(root)
    const outside = await mkdtemp(join(tmpdir(), 'agent-team-workspace-outside-'))
    temporaryDirectories.push(outside)
    const absolute = join(outside, 'victim.txt')
    await writeFile(absolute, 'keep')
    const service = await createService(root)
    try {
      try {
        await service.deleteFile('team-1', absolute)
        expect.unreachable('should have thrown')
      } catch (error) {
        expectInvalidRequest(error)
      }
      await expect(readFile(absolute, 'utf8')).resolves.toBe('keep')
    } finally {
      await service.dispose()
    }
  })

  it('边界-symlink 指向工作区外拒绝删除', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-team-workspace-delete-'))
    temporaryDirectories.push(root)
    const outside = await mkdtemp(join(tmpdir(), 'agent-team-workspace-outside-'))
    temporaryDirectories.push(outside)
    const outsideFile = join(outside, 'secret.txt')
    await writeFile(outsideFile, 'secret')
    if (!await createSymlink(outsideFile, join(root, 'evil.txt'))) {
      console.warn('symlink unavailable on this environment; skipped')
      return
    }
    const service = await createService(root)
    try {
      try {
        await service.deleteFile('team-1', 'evil.txt')
        expect.unreachable('should have thrown')
      } catch (error) {
        expectInvalidRequest(error)
      }
      await expect(readFile(outsideFile, 'utf8')).resolves.toBe('secret')
    } finally {
      await service.dispose()
    }
  })

  it('异常-权限不足返回 WORKSPACE_FILE_DELETE_FAILED（非 Windows）', async () => {
    if (platform === 'win32') {
      console.warn('chmod-based permission simulation unreliable on Windows; skipped')
      return
    }
    const root = await mkdtemp(join(tmpdir(), 'agent-team-workspace-delete-'))
    temporaryDirectories.push(root)
    await mkdir(join(root, 'locked'), { recursive: true })
    await writeFile(join(root, 'locked', 'file.txt'), 'x')
    await chmod(join(root, 'locked'), 0o444)
    const service = await createService(root)
    try {
      try {
        await service.deleteFile('team-1', 'locked/file.txt')
        expect.unreachable('should have thrown')
      } catch (error) {
        expect(error).toBeInstanceOf(AgentTeamError)
        expect((error as AgentTeamError).code).toBe('WORKSPACE_FILE_DELETE_FAILED')
      }
    } finally {
      await chmod(join(root, 'locked'), 0o755)
      await service.dispose()
    }
  })
})
