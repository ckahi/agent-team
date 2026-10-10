import { preloadFile } from '@pierre/diffs/ssr'
import { codeLanguageForPath } from '../domain/code-language.js'

/**
 * 服务端全文件语法高亮渲染（@pierre/diffs SSR + shiki，与 team.workspace.diff 同链路）。
 * 输出为自包含 prerenderedHTML（含主题样式），客户端注入 shadow root 即得完整配色。
 *
 * 缓存：同 (path, theme, mtimeMs, bytes) 的渲染结果做进程内 LRU（上限 32 条），
 * 重复打开同一文件零 SSR 成本；文件变化（mtime/大小）自动失配重渲染。
 * tokenize 上限与 team.workspace.diff 渲染器一致（单行 2000 字符 / 全文 200k 字符），
 * 超限部分 shiki 降级为普通文本渲染，属同一既有行为而非本功能新增阈值。
 */
const HIGHLIGHT_CACHE_LIMIT = 32
const highlightCache = new Map<string, string>()

export async function renderWorkspaceFileHighlight(
  content: string,
  path: string,
  theme: 'light' | 'dark',
  mtimeMs: number,
  bytes: number,
): Promise<string> {
  const language = codeLanguageForPath(path)
  if (language === undefined) return ''
  const cacheKey = `${theme}:${path}:${mtimeMs}:${bytes}`
  const cached = highlightCache.get(cacheKey)
  if (cached !== undefined) {
    // LRU 触碰：移到末尾复用 Map 的插入序。
    highlightCache.delete(cacheKey)
    highlightCache.set(cacheKey, cached)
    return cached
  }
  const result = await preloadFile({
    file: { name: path, contents: content },
    options: {
      theme: theme === 'dark' ? 'pierre-dark' : 'pierre-light',
      themeType: theme,
      disableFileHeader: true,
      overflow: 'scroll',
      disableLineNumbers: true,
      tokenizeMaxLineLength: 2_000,
      tokenizeMaxLength: 200_000,
    },
  })
  const html = result.prerenderedHTML
  highlightCache.set(cacheKey, html)
  while (highlightCache.size > HIGHLIGHT_CACHE_LIMIT) {
    const oldest = highlightCache.keys().next().value
    if (oldest === undefined) break
    highlightCache.delete(oldest)
  }
  return html
}
