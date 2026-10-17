/**
 * 判断是否为"纯对象"：合并时只有纯对象才递归，数组与 `null` 一律整值替换
 * （设计 §3 合并规则 2/3——`plugins` 数组不拼接）。
 *
 * @param value 待判定的值
 * @returns 是 `typeof === 'object'` 且非 `null`、非数组
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 深合并覆盖层到基础对象（设计 §3 合并规则）。
 *
 * 规则（优先级由低到高：基础对象 → 覆盖层）：
 * 1. `override` 中值为 `undefined` 的键**跳过**——这是 flags 层"未设置"的唯一表达方式，
 *    `undefined` 不得把下层值浇成空；
 * 2. 两侧同为纯对象 → 递归合并；
 * 3. 其余（数组、原始值、`null`）→ 整值替换；
 * 4. `__proto__` 键**直接丢弃**：`JSON.parse` 会产出该自有键，直接赋值会触发
 *    `Object.prototype` 的 setter（原型污染），配置来自用户文件必须防；
 * 5. **纯函数**：结果基于 `base` 的浅拷贝构造，两个入参的内容都不被修改。
 *
 * @param base 基础对象（通常是默认值或上一层合并结果）
 * @param override 覆盖层（可为 `undefined`，表示"无覆盖"）
 * @returns 合并后的新对象（与 `base` 同型；浅拷贝层级以下按需递归复制）
 */
export function deepMerge<T extends Record<string, unknown>>(
  base: T,
  override: Record<string, unknown> | undefined,
): T {
  if (override === undefined) return base
  const result: Record<string, unknown> = { ...base }
  for (const key of Object.keys(override)) {
    // 规则 4：原型污染防护（在读取值之前拦截，避免触发 setter）
    if (key === '__proto__') continue
    const next = override[key]
    // 规则 1：undefined 表示"该层未设置"
    if (next === undefined) continue
    const prev = result[key]
    // 规则 2/3：仅两侧都是纯对象才递归，其余整值替换
    result[key] = isPlainObject(prev) && isPlainObject(next) ? deepMerge(prev, next) : next
  }
  return result as T
}
