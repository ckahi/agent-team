/**
 * 预览语法高亮的扩展名 → highlight 语言 id 映射（客户端与服务端共用）。
 * 覆盖常用集合即可；html/vue/svelte 复用 xml 语法，markdown 走独立渲染管线不在此列。
 */
const CODE_LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.css': 'css',
  '.json': 'json',
  '.jsonc': 'json',
  '.go': 'go',
  '.py': 'python',
  '.java': 'java',
  '.rs': 'rust',
  '.c': 'cpp',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.h': 'cpp',
  '.hpp': 'cpp',
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'bash',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'ini',
  '.sql': 'sql',
  '.html': 'xml',
  '.htm': 'xml',
  '.xml': 'xml',
  '.vue': 'xml',
  '.svelte': 'xml',
}

/** 未收录扩展名/无扩展名返回 undefined（客户端回退纯文本）。 */
export function codeLanguageForPath(path: string): string | undefined {
  const name = path.split('/').pop() ?? ''
  if (!name.includes('.')) return undefined
  const extension = name.slice(name.lastIndexOf('.')).toLowerCase()
  return CODE_LANGUAGE_BY_EXTENSION[extension]
}
