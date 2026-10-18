#!/usr/bin/env node
/* global process, setTimeout */
/**
 * `mdsh` 的 bin 引导脚本（架构 §2：bin 入口 `mdsh`）。
 *
 * 刻意**不用 TS**：它是 dist 产物的启动器，参与 tsc 编译只会让输出路径多一层；
 * 因此也不计入模块 LOC 预算（process.md §6 的口径是 `.ts` 源码）。
 *
 * 退出策略：先设 `process.exitCode` 让 Node 自然收尾（stdout 得以 flush），
 * 再挂一个 unref 的兜底 timer——若仍有残留 handle 拖住事件循环，100ms 后强制退出。
 */

import { main } from '../dist/src/cli/main.js'

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
    const timer = setTimeout(() => process.exit(code), 100)
    timer.unref()
  },
  (err) => {
    const text = err instanceof Error ? (err.stack ?? err.message) : String(err)
    process.stderr.write(`[mdsh] 未捕获的启动错误：${text}\n`)
    process.exit(1)
  },
)
