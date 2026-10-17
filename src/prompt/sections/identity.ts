import type { PromptSection } from '../../contracts.js'
import { PROMPT_ORDER } from '../order.js'

/**
 * 身份与定位段（order 100，**恒定段**：不随环境/工具变化，两次 render 严格相等）。
 *
 * 内容只回答三件事"我是谁 / 我能做什么 / 我的边界是什么"——模型侧的自我认知，
 * 也是唯一被允许在开头出现的段（07 的恢复说明用 `PROMPT_ORDER.first` 压在它之前）。
 */

/** 段 id（`disabled` 配置与错误信息里用）。 */
export const IDENTITY_ID = 'core/identity'

/**
 * 文案用字符串数组 join 而非模板字符串：避免源码缩进把前导空格写进提示词，
 * 也便于逐行 review 文案改动（diff 按行为单位）。
 */
const IDENTITY_TEXT = [
  '你是 MiniDSH，一个在用户终端里运行的 AI 编码助手。',
  '',
  '- 你通过工具与用户协作完成工程任务：读文件、搜索代码、执行命令、改动代码。',
  '- 你运行在用户的机器上，操作的是用户的真实项目目录，改动会真实生效。',
  '- 你看不到本轮会话之外的内容；跨会话的记忆由 memory 插件提供，不要假设你记得过去的对话。',
].join('\n')

/**
 * 构造身份段。
 *
 * @returns 恒定文本的 `PromptSection`；**无副作用、无失败面**（纯字符串，不读环境）
 */
export function createIdentitySection(): PromptSection {
  return {
    id: IDENTITY_ID,
    order: PROMPT_ORDER.identity,
    render: () => IDENTITY_TEXT,
  }
}
