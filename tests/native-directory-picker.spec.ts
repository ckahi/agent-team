import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { AGENT_TEAM_PICK_DIRECTORY_PATH } from '../src/transport/contracts.js'
import {
  encodePickCommand,
  registerNativeDirectoryPicker,
} from '../src/runtime/native-directory-picker.js'

interface RegisteredRoute {
  kind: string
  path: string
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> | void
}

function contextWithRoute(): { ctx: Context; route: () => RegisteredRoute } {
  const registered: RegisteredRoute[] = []
  const ctx = {
    webServer: {
      register: vi.fn((route: RegisteredRoute) => {
        registered.push(route)
        return () => undefined
      }),
    },
  } as unknown as Context
  return { ctx, route: () => registered[0]! }
}

class FakeRequest extends EventEmitter {
  override off(name: string, listener: () => void): this {
    this.removeListener(name, listener)
    return this
  }
}

class FakeResponse {
  headers: Record<string, string> = {}
  statusCode = 0
  body = ''

  setHeader(name: string, value: string): void {
    this.headers[name] = value
  }

  writeHead(status: number): this {
    this.statusCode = status
    return this
  }

  end(body: string): void {
    this.body = body
  }
}

async function handle(pick: (signal: AbortSignal) => Promise<string | null>): Promise<{
  response: FakeResponse
}> {
  const { ctx, route } = contextWithRoute()
  registerNativeDirectoryPicker(ctx, { pick })
  const request = new FakeRequest() as unknown as IncomingMessage
  const response = new FakeResponse() as unknown as ServerResponse & FakeResponse
  await route().handler(request, response as unknown as ServerResponse)
  return { response }
}

describe('native directory picker route', () => {
  it('registers an exact JSON route at the pick-directory path', () => {
    const { ctx, route } = contextWithRoute()
    const dispose = registerNativeDirectoryPicker(ctx)
    expect(dispose).toBeTypeOf('function')
    expect(route().kind).toBe('exact')
    expect(route().path).toBe(AGENT_TEAM_PICK_DIRECTORY_PATH)
  })

  it('answers ok with the picked path', async () => {
    const { response } = await handle(() => Promise.resolve('E:\\workspaces\\demo'))
    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body)).toEqual({ ok: true, path: 'E:\\workspaces\\demo' })
  })

  it('answers ok with a null path on cancellation', async () => {
    const { response } = await handle(() => Promise.resolve(null))
    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body)).toEqual({ ok: true, path: null })
  })

  it('answers a failure with the error message', async () => {
    const { response } = await handle(() => Promise.reject(new Error('no chooser')))
    expect(response.statusCode).toBe(500)
    expect(JSON.parse(response.body)).toEqual({ ok: false, message: 'no chooser' })
  })

  it('aborts the pick when the client disconnects first', async () => {
    const { ctx, route } = contextWithRoute()
    registerNativeDirectoryPicker(ctx, {
      pick: signal => new Promise<string | null>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason))
      }),
    })
    const request = new FakeRequest() as unknown as IncomingMessage
    const response = new FakeResponse() as unknown as ServerResponse & FakeResponse
    const settled = route().handler(request, response as unknown as ServerResponse) as Promise<void>
    request.emit('close')
    await settled
    expect(response.statusCode).toBe(500)
    const body = JSON.parse(response.body) as { ok: boolean; message: string }
    expect(body.ok).toBe(false)
    expect(body.message).not.toBe('')
  })
})

describe('encodePickCommand', () => {
  it('encodes the UTF-16LE script carrying the dialog title', () => {
    const encoded = encodePickCommand('选择文件夹')
    const script = Buffer.from(encoded, 'base64').toString('utf16le')
    expect(script).toContain('FolderBrowserDialog')
    expect(script).toContain('TopMost')
    expect(script).toContain('选择文件夹')
    expect(script).toContain('OutputEncoding')
  })

  it('escapes single quotes in the title', () => {
    const script = Buffer.from(encodePickCommand("it's"), 'base64').toString('utf16le')
    expect(script).toContain("it''s")
  })
})
