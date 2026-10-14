import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const cssPath = fileURLToPath(new URL('../src/client/AgentTeam.module.css', import.meta.url))
const css = readFileSync(cssPath, 'utf8')

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`\\.${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(css)
  if (!match) throw new Error(`rule .${selector} should exist in AgentTeam.module.css`)
  return match[1] ?? ''
}

describe('team management dialog scroll (regression)', () => {
  it('约束-dialog 最大高度不依赖视口 calc', () => {
    const body = ruleBody('managementDialog')
    expect(body).toContain('max-height: min(820px, 100%)')
    expect(body).not.toContain('100vh')
  })

  it('约束-内容列是可收缩的 flex column', () => {
    const body = ruleBody('managementDialogContent')
    expect(body).toContain('display: flex')
    expect(body).toContain('flex-direction: column')
    expect(body).toContain('min-height: 0')
  })

  it('约束-宿主 .body 包装层（content 唯一直接子元素）必须允许收缩', () => {
    // 宿主 Modal 把 children 包在 .body（无 min-height:0，默认 min-height:auto 拒绝收缩），
    // 收缩链在 content→body 之间断掉，必须由插件侧用子选择器补上
    expect(css).toMatch(/\.managementDialogContent\s*>\s*\*\s*\{[^}]*min-height:\s*0/)
  })

  it('约束-滚动区用 flex 占据剩余空间而非视口 max-height', () => {
    const body = ruleBody('managementDialogBody')
    expect(body).toContain('flex: 1 1 auto')
    expect(body).toContain('min-height: 0')
    expect(body).toContain('overflow-y: auto')
    expect(body).not.toContain('100vh')
  })
})
