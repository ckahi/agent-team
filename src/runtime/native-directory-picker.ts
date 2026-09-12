import { spawn } from 'node:child_process'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { AGENT_TEAM_PICK_DIRECTORY_PATH } from '../transport/contracts.js'

/**
 * Pick function driving the route; the default opens the Windows native folder
 * dialog through PowerShell's `Shell.Application` COM (`BrowseForFolder`).
 * Injectable so the route wiring stays unit-testable.
 */
export type PickDirectory = (signal: AbortSignal) => Promise<string | null>

export interface NativeDirectoryPickerOptions {
  pick?: PickDirectory
}

/** The dialog title (passed to the chooser). */
const PICK_DIALOG_TITLE = '选择文件夹'

/**
 * Build the Base64-encoded `-EncodedCommand` payload: Base64 of the UTF-16LE
 * script, so the Chinese title and any output handling survive without
 * depending on the caller's console codepage.
 * @param title - dialog title shown by the chooser.
 * @returns the encoded command string for `powershell -EncodedCommand`.
 */
export function encodePickCommand(title: string): string {
  const script = [
    '$ErrorActionPreference = \'Stop\'',
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    'Add-Type -AssemblyName System.Windows.Forms',
    // The host process is a background process, so a plain dialog opens
    // BEHIND every window (the harness's own native backend synthesizes an
    // Alt press for the same reason). A TopMost owner form forces the
    // dialog to the foreground instead.
    '$owner = New-Object System.Windows.Forms.Form',
    '$owner.TopMost = $true',
    '$owner.ShowInTaskbar = $false',
    '$owner.FormBorderStyle = \'None\'',
    '$owner.Size = New-Object System.Drawing.Size(1, 1)',
    '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
    `$dialog.Description = '${title.replace(/'/g, '\'\'')}'`,
    '$dialog.ShowNewFolderButton = $true',
    'if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {',
    '  [Console]::Out.Write($dialog.SelectedPath)',
    '}',
    '$owner.Dispose()',
  ].join('\n')
  return Buffer.from(script, 'utf16le').toString('base64')
}

/**
 * Open the Windows native folder dialog and resolve the picked path.
 * Spawns `powershell.exe -NoProfile -NonInteractive -EncodedCommand …`; the
 * dialog is the OS's own folder picker raised above every window by a TopMost
 * owner form (the spawning host is a background process). Cancellation kills
 * the process, closing the dialog. An empty output — the operator's cancel —
 * resolves null.
 * @param signal - caller cancellation.
 * @returns the chosen absolute path, or null when cancelled.
 */
export function pickDirectoryViaPowerShell(signal: AbortSignal): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-EncodedCommand', encodePickCommand(PICK_DIALOG_TITLE),
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      fn()
    }
    const onAbort = (): void => {
      child.kill()
      settle(() => reject(new Error('directory picker was aborted')))
    }
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('error', (error: Error) => {
      settle(() => reject(new Error(`directory picker failed to start: ${error.message}`)))
    })
    child.on('close', (code) => {
      if (signal.aborted) {
        settle(() => reject(new Error('directory picker was aborted')))
        return
      }
      if (code !== 0) {
        settle(() => reject(new Error(`directory picker failed (exit ${String(code)}): ${stderr.trim()}`)))
        return
      }
      const path = stdout.trim()
      settle(() => resolve(path === '' ? null : path))
    })
  })
}

/**
 * Register the Client→Host JSON route backing the workspace directory picker.
 * The route answers `{ ok: true, path }` — `path` is null on cancellation — or
 * `{ ok: false, message }` on failure. A disconnected client aborts the pick,
 * which closes the still-open dialog.
 * @param ctx - host context carrying the `webServer` service.
 * @param options - test seams.
 * @returns route disposer.
 */
export function registerNativeDirectoryPicker(
  ctx: Context,
  options: NativeDirectoryPickerOptions = {},
): () => void {
  const pick = options.pick ?? pickDirectoryViaPowerShell
  const dispose = ctx.webServer.register({
    kind: 'exact',
    path: AGENT_TEAM_PICK_DIRECTORY_PATH,
    handler: async (request: IncomingMessage, response: ServerResponse) => {
      response.setHeader('Content-Type', 'application/json')
      response.setHeader('Cache-Control', 'no-store')
      const controller = new AbortController()
      let settled = false
      const onClientGone = (): void => {
        if (!settled) controller.abort()
      }
      request.on('close', onClientGone)
      try {
        const path = await pick(controller.signal)
        settled = true
        response.writeHead(200)
        response.end(JSON.stringify({ ok: true, path }))
      } catch (error) {
        settled = true
        const message = error instanceof Error ? error.message : String(error)
        response.writeHead(500)
        response.end(JSON.stringify({ ok: false, message }))
      } finally {
        request.off('close', onClientGone)
      }
    },
  })
  return dispose
}
