import type { MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * MarkdownText 要求引用稳定的本地化标签对象（新建身份会丢弃流式渲染缓存），
 * 这里提供固定的中文文案，整个客户端共享同一实例。
 */
export const MARKDOWN_LABELS: MarkdownLabels = {
  code: { copyLabel: '复制代码', copiedLabel: '已复制' },
  footnotes: '脚注',
}
