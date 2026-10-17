import type { PromptSection } from '../../contracts.js'
import { PROMPT_ORDER } from '../order.js'

/**
 * 工作准则段（order 800，**恒定段**）。
 *
 * 放最后（800）：准则是对前面所有段的约束，紧邻用户输入前出现最有效。
 * 五条准则都指向"少做不该做的事"——mini 版没有复杂策略层，靠这几条压住
 * 模型的过度发挥（顺手重构、臆造结论、不问就大改）。
 */

/** 段 id（`disabled` 配置与错误信息里用）。 */
export const GUIDELINES_ID = 'core/guidelines'

const GUIDELINES_TEXT = [
  '# 工作准则',
  '',
  '- 先读后改：改动文件前先读取相关片段，确保改动基于真实内容。',
  '- 最小改动：只做完成任务必需的修改，不顺手重构、不增删无关代码。',
  '- 不确定就问：需求有歧义或影响面大时，先向用户确认再动手。',
  '- 结论要有据：只说你验证过的内容；未验证的部分明确标注“未验证”。',
  '- 回答简洁，使用中文（与用户语言保持一致）。',
].join('\n')

/**
 * 构造工作准则段。
 *
 * @returns 恒定文本的 `PromptSection`；**无副作用、无失败面**
 */
export function createGuidelinesSection(): PromptSection {
  return {
    id: GUIDELINES_ID,
    order: PROMPT_ORDER.guidelines,
    render: () => GUIDELINES_TEXT,
  }
}
