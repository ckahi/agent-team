import { createServer, request as httpRequest, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from '../src/config.js'
import type { AgentTeamService } from '../src/service/agent-team-service.js'
import {
  AGENT_TEAM_API_PATH,
  type AgentTeamCommandBridge,
  type CommandExecutionView,
} from '../src/transport/contracts.js'
import { registerWebTransport } from '../src/transport/web.js'

/**
 * C-1 回归：命令执行 RPC 的取消边界。
 * IncomingMessage 的 'close' 在 body 读尽时即发射（Node ≥15），不能作为客户端断连信号；
 * 正确挂载点是 response 'close' + writableEnded 守卫。
 */

interface CapturedHandler {
  handler: (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => Promise<void>
}

function fakeContext(handlers: Map<string, CapturedHandler['handler']>): Context {
  return {
    webServer: {
      register: (definition: {
        path: string
        handler: (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => Promise<void>
      }) => {
        handlers.set(definition.path, definition.handler)
        return () => undefined
      },
    },
    logger: { error() {}, warn() {}, info() {} },
  } as unknown as Context
}

const config = {
  sseHeartbeatMs: 3_600_000,
  maxRequestBytes: 1024 * 1024,
} as unknown as Config

const serviceStub = {
  subscribe: () => () => undefined,
} as unknown as AgentTeamService

describe('transport abort boundary for command execution', () => {
  const handlers = new Map<string, CapturedHandler['handler']>()
  const bridge: AgentTeamCommandBridge = {
    listMemberCommands: async () => [],
    executeMemberCommand: async () => {
      throw new Error('bridge not configured for this test')
    },
    compactAllMembers: async () => ({ compacted: [], skipped: [] }),
  }
  let transport: ReturnType<typeof registerWebTransport>
  let server: Server
  let port = 0

  beforeAll(async () => {
    transport = registerWebTransport(fakeContext(handlers), config, serviceStub, bridge)
    server = createServer((request, response) => {
      const handler = handlers.get((request.url ?? '').split('?')[0]!)
      if (handler === undefined) {
        response.writeHead(404).end()
        return
      }
      void handler(request, response)
    })
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
    port = (server.address() as { port: number }).port
  })

  afterAll(async () => {
    transport.dispose()
    await new Promise<void>(resolve => { server.close(() => resolve()) })
  })

  it('does not abort when the request completes normally', async () => {
    let receivedSignal: AbortSignal | undefined
    bridge.executeMemberCommand = async (_teamId, _slotId, _line, signal) => {
      receivedSignal = signal
      const execution: CommandExecutionView = { commandId: 'cmd-ok', result: { kind: 'success' } }
      return execution
    }
    const response = await fetch(`http://127.0.0.1:${port}${AGENT_TEAM_API_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: 'normal-1',
        method: 'team.command.execute',
        payload: { teamId: 'team-1', slotId: 'slot-1', line: '/echo hi' },
      }),
    })
    const body = await response.text()
    expect(body, `status=${response.status}`).toContain('"ok":true')
    expect(receivedSignal).toBeDefined()
    expect(receivedSignal!.aborted).toBe(false)
  })

  it('aborts the execution signal when the client disconnects mid-request', async () => {
    let receivedSignal: AbortSignal | undefined
    bridge.executeMemberCommand = async (_teamId, _slotId, _line, signal) => {
      receivedSignal = signal
      return new Promise<CommandExecutionView>(resolve => {
        signal.addEventListener('abort', () => resolve({ commandId: 'cmd-cut', result: { kind: 'success' } }), { once: true })
      })
    }
    const clientRequest = httpRequest({
      host: '127.0.0.1',
      port,
      path: AGENT_TEAM_API_PATH,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
    const settled = new Promise<void>(resolve => {
      clientRequest.on('error', () => resolve())
      clientRequest.on('close', () => resolve())
    })
    clientRequest.end(JSON.stringify({
      requestId: 'cut-1',
      method: 'team.command.execute',
      payload: { teamId: 'team-1', slotId: 'slot-1', line: '/compact' },
    }))
    // 等 handler 进入（body 已被服务端读尽、executeMemberCommand 已被调用）再断连
    await vi.waitFor(() => { expect(receivedSignal).toBeDefined() }, { timeout: 2_000 })
    clientRequest.destroy()
    await settled
    // 断连后 execute 的 signal 必须被触发（宿主命令据此中止）
    await new Promise(resolve => { setTimeout(resolve, 50) })
    expect(receivedSignal!.aborted).toBe(true)
  })
})
