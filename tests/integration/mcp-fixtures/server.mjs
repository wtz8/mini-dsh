#!/usr/bin/env node
/**
 * MiniDSH 09-plugin-mcp 集成测试的 stdio MCP fixture server。
 *
 * 单文件按 argv 开关切换行为（设计 §6.2；与 03 的 session-fixtures 同式，
 * 评审时可整文件阅读）：
 *
 *   --mode=echo    握手 + 两个工具：echo（回显参数 text）/ boom（isError: true）
 *   --mode=slow    握手 + sleep 工具：收到调用先写标记再挂起（永不应答，配合取消链路）
 *   --mode=crash   应答 initialize 后立即退出（tools/list 必失败 ⇒ 启动失败路径）
 *   --mode=notools 握手但不声明 tools 能力（零工具、不算失败）
 *   --mark=<path>  标记文件：写 `pid:<n>` / `called:<tool>` / `cancelled` / `crashed`
 *                  等事实行。测试**等标记而不是等时间**（06 Y4 / 05 Y5 的教训）。
 *
 * 协议：换行分帧 JSON-RPC（与 09 客户端实现一致），stdout 出、stdin 入；
 * stderr 启动即写一行诊断（Q13：验证 stderr 只进日志、永不进工具结果）。
 */
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

/** 解析 `--name=value` 形式的命令行参数。 */
function argOf(name) {
  const prefix = `--${name}=`
  const hit = process.argv.find((a) => a.startsWith(prefix))
  return hit === undefined ? undefined : hit.slice(prefix.length)
}

const mode = argOf('mode') ?? 'echo'
const markFile = argOf('mark')

/** 把一行事实写进标记文件（appendFileSync 同步落盘，读侧立即可见）。 */
function mark(label) {
  if (markFile !== undefined) appendFileSync(markFile, `${label}\n`, 'utf8')
}

/** 写一条 JSON-RPC 消息到 stdout。 */
function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`)
}

/** 应答一个请求。 */
function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

/** 各模式声明的工具清单。 */
const TOOLS = {
  echo: [
    {
      name: 'echo',
      description: '原样返回参数中的 text',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', description: '要回显的文本' } },
        required: ['text'],
        additionalProperties: false,
      },
    },
    {
      name: 'boom',
      description: '总是失败（isError: true）',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
  slow: [
    {
      name: 'sleep',
      description: '长任务：永不主动返回（配合取消链路）',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}

const capabilities = mode === 'notools' ? {} : { tools: {} }

mark(`pid:${process.pid}`)
process.stderr.write(`[fixture-${mode}] stderr 诊断行\n`)

createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim() === '') return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.method === 'initialize') {
    reply(msg.id, {
      protocolVersion: '2025-06-18',
      capabilities,
      serverInfo: { name: `fixture-${mode}` },
    })
    if (mode === 'crash') {
      mark('crashed')
      // 稍等片刻再退：让 initialized 通知先写进管道
      setTimeout(() => process.exit(1), 20)
    }
    return
  }
  if (msg.method === 'tools/list') {
    reply(msg.id, { tools: TOOLS[mode] ?? [] })
    return
  }
  if (msg.method === 'tools/call') {
    const name = msg.params?.name
    if (mode === 'slow') {
      mark(`called:${name}`)
      return // 永不应答：客户端只能靠取消/超时收场
    }
    if (name === 'echo') {
      mark(`called:${name}`)
      reply(msg.id, {
        content: [{ type: 'text', text: `echo:${msg.params?.arguments?.text ?? ''}` }],
        isError: false,
      })
      return
    }
    if (name === 'boom') {
      mark(`called:${name}`)
      reply(msg.id, { content: [{ type: 'text', text: '故意失败' }], isError: true })
      return
    }
    reply(msg.id, { content: [], isError: false })
    return
  }
  if (msg.method === 'notifications/cancelled') {
    mark('cancelled')
    return
  }
  // 其余通知（notifications/initialized 等）按规范忽略
})
