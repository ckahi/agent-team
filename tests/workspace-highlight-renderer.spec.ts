import { describe, expect, it } from 'vitest'
import { renderWorkspaceFileHighlight } from '../src/service/workspace-highlight-renderer.js'

describe('renderWorkspaceFileHighlight', () => {
  it('正常-TypeScript 源码渲染出非空高亮 HTML', async () => {
    const html = await renderWorkspaceFileHighlight('const x = 1\n', 'src/main.ts', 'light', 1, 12)
    expect(html.length).toBeGreaterThan(0)
  })

  it('正常-html 扩展名渲染出非空高亮 HTML', async () => {
    const html = await renderWorkspaceFileHighlight('<!doctype html><p>hi</p>\n', 'page.html', 'dark', 1, 26)
    expect(html.length).toBeGreaterThan(0)
  })

  it('边界-未收录扩展名返回空串（客户端回退纯文本）', async () => {
    const html = await renderWorkspaceFileHighlight('plain text\n', 'notes.txt', 'light', 1, 11)
    expect(html).toBe('')
  })

  it('缓存-同 (path, theme, mtime, size) 命中同一字符串引用', async () => {
    const first = await renderWorkspaceFileHighlight('const a = 1\n', 'a.ts', 'light', 100, 12)
    const second = await renderWorkspaceFileHighlight('const a = 1\n', 'a.ts', 'light', 100, 12)
    expect(second).toBe(first)
  })

  it('缓存-内容变化（mtime 变化）重新渲染为新引用', async () => {
    const first = await renderWorkspaceFileHighlight('const a = 1\n', 'b.ts', 'light', 100, 12)
    const second = await renderWorkspaceFileHighlight('const a = 2\nconst b = 3\n', 'b.ts', 'light', 200, 26)
    expect(second).not.toBe(first)
    expect(second.length).toBeGreaterThan(0)
  })

  it('缓存-主题不同各自缓存不串色', async () => {
    const light = await renderWorkspaceFileHighlight('const a = 1\n', 'c.ts', 'light', 100, 12)
    const dark = await renderWorkspaceFileHighlight('const a = 1\n', 'c.ts', 'dark', 100, 12)
    expect(dark).not.toBe(light)
  })
})
