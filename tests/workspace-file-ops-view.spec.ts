import { describe, expect, it } from 'vitest'
import { codeLanguageForPath, deleteErrorFeedback, isMarkdownPath, readErrorText } from '../src/client/workspace/file-ops-view.js'

describe('isMarkdownPath', () => {
  it('正常-.md/.markdown 识别为 markdown', () => {
    expect(isMarkdownPath('README.md')).toBe(true)
    expect(isMarkdownPath('docs/guide.markdown')).toBe(true)
    expect(isMarkdownPath('a/b.NOTE.MD')).toBe(true)
  })

  it('边界-非 markdown 扩展名返回 false', () => {
    expect(isMarkdownPath('src/main.ts')).toBe(false)
    expect(isMarkdownPath('notes.md.txt')).toBe(false)
    expect(isMarkdownPath('noext')).toBe(false)
  })
})

describe('codeLanguageForPath', () => {
  it('正常-常用扩展名映射到 highlight.js 语言 id', () => {
    expect(codeLanguageForPath('src/main.ts')).toBe('typescript')
    expect(codeLanguageForPath('app/component.tsx')).toBe('typescript')
    expect(codeLanguageForPath('index.js')).toBe('javascript')
    expect(codeLanguageForPath('chunk.mjs')).toBe('javascript')
    expect(codeLanguageForPath('style.css')).toBe('css')
    expect(codeLanguageForPath('package.json')).toBe('json')
    expect(codeLanguageForPath('cmd/server.go')).toBe('go')
    expect(codeLanguageForPath('tools/run.py')).toBe('python')
    expect(codeLanguageForPath('Main.java')).toBe('java')
    expect(codeLanguageForPath('lib.rs')).toBe('rust')
    expect(codeLanguageForPath('a.c')).toBe('cpp')
    expect(codeLanguageForPath('a.cpp')).toBe('cpp')
    expect(codeLanguageForPath('a.h')).toBe('cpp')
    expect(codeLanguageForPath('run.sh')).toBe('bash')
    expect(codeLanguageForPath('run.bash')).toBe('bash')
    expect(codeLanguageForPath('ci.yml')).toBe('yaml')
    expect(codeLanguageForPath('ci.yaml')).toBe('yaml')
    expect(codeLanguageForPath('Cargo.toml')).toBe('ini')
    expect(codeLanguageForPath('query.sql')).toBe('sql')
    expect(codeLanguageForPath('page.html')).toBe('xml')
    expect(codeLanguageForPath('Comp.vue')).toBe('xml')
    expect(codeLanguageForPath('Comp.svelte')).toBe('xml')
  })

  it('正常-大小写不敏感', () => {
    expect(codeLanguageForPath('README.TS')).toBe('typescript')
    expect(codeLanguageForPath('Config.JSON')).toBe('json')
  })

  it('边界-未收录/无扩展名/markdown 返回 undefined（走纯文本）', () => {
    expect(codeLanguageForPath('README.md')).toBeUndefined()
    expect(codeLanguageForPath('notes.md.txt')).toBeUndefined()
    expect(codeLanguageForPath('noext')).toBeUndefined()
    expect(codeLanguageForPath('data.bin')).toBeUndefined()
  })
})

describe('readErrorText', () => {
  it('P-QA-1-客户端 .code 构造错误（api.ts 真实形态）映射内容失效文案', () => {
    const error = Object.assign(new Error('Workspace path does not exist'), { code: 'INVALID_REQUEST' })
    expect(readErrorText(error)).toBe('该文件已被删除或移动，内容已不可用')
  })

  it('其它 INVALID_REQUEST 透传原因', () => {
    const error = Object.assign(new Error('Workspace path must be relative'), { code: 'INVALID_REQUEST' })
    expect(readErrorText(error)).toBe('读取失败：Workspace path must be relative')
  })
})

describe('deleteErrorFeedback', () => {  it('瞬时错误-删除失败码给重试与原因透传', () => {
    const error = Object.assign(new Error("Unable to delete Workspace file 'a.txt' (team 't'): EBUSY"), { code: 'WORKSPACE_FILE_DELETE_FAILED' })
    expect(deleteErrorFeedback(error)).toEqual({
      text: "删除失败：Unable to delete Workspace file 'a.txt' (team 't'): EBUSY",
      retryable: true,
    })
  })

  it('校验类错误-路径逃逸/绝对路径不给重试', () => {
    const error = Object.assign(new Error('Workspace path escapes the team Workspace'), { code: 'INVALID_REQUEST' })
    expect(deleteErrorFeedback(error)).toEqual({
      text: '删除失败：路径校验失败，已阻止该操作。',
      retryable: false,
    })
  })

  it('校验类错误-目录删除给专用文案', () => {
    const error = Object.assign(new Error("Workspace path 'folder' is a directory"), { code: 'INVALID_REQUEST' })
    expect(deleteErrorFeedback(error)).toEqual({
      text: '删除失败：目录不支持删除。',
      retryable: false,
    })
  })

  it('Workspace 不可用/团队不存在给统一文案', () => {
    const unavailable = Object.assign(new Error('gone'), { code: 'WORKSPACE_UNAVAILABLE' })
    const unknownTeam = Object.assign(new Error('gone'), { code: 'TEAM_NOT_FOUND' })
    expect(deleteErrorFeedback(unavailable)).toEqual({
      text: '删除失败：Workspace 不可用或已变更。',
      retryable: false,
    })
    expect(deleteErrorFeedback(unknownTeam).text).toBe('删除失败：Workspace 不可用或已变更。')
  })

  it('超时按失败处理且可重试', () => {
    expect(deleteErrorFeedback(new Error('请求超时：team.workspace.delete'))).toEqual({
      text: '操作超时，请重试',
      retryable: true,
    })
  })

  it('未知错误兜底可重试并透传原因', () => {
    const feedback = deleteErrorFeedback(new Error('boom'))
    expect(feedback.retryable).toBe(true)
    expect(feedback.text).toContain('boom')
  })
})
