# bash 工具的取消会把回合挂满整个命令时长（P1，已修）

- 发现日期：2026-10-19
- 基线：HEAD `a67c09e` 起；改动落在**已提交的模块** `src/tools/builtin/bash.ts`（05-tools），尚未提交
- 位置：`src/tools/builtin/bash.ts` 的 `killTree()` 与 `createBashTool().execute` 内的 `onAbort`
- 方法：**动态探针实证**（5 例临时探针，跑完即删、不入库），非静态阅读。全部结论均有可复现的实测数据，见 §3
- 等级：**P1** —— 用户可感知的功能失效（Ctrl+C 不生效），且影响的是最日常的复合命令

## 结论

`bash` 工具在 Windows 上取消**复合命令**时，`taskkill /T /F` 杀不到 MSYS fork 出来的孙进程；该孤儿握着继承去的 stdout 管道句柄，Node 的 `'close'` 事件要等它自然退出，**于是取消一次要等到命令自己跑完**——实测 60.7 秒（等于睡满 60 秒）。

修法是在杀树之外**立刻 `destroy()` 掉 stdio**，把回合从管道上摘下来（60.7s → 0.97s）。孤儿进程仍可能残留，这是零运行时依赖下无法根除的代价，已记为已知局限 **F-04**。

## 一、现象

用户按下 Ctrl+C（触发 `env.signal` 的 abort）后，工具本应立即抛"命令已取消"并结束回合。但命令若是**复合**的（`a; b`、`a && b`、`a | b`），回合会一直挂到命令自然结束。

## 二、复现

最小复现（Windows + Git Bash，可直接 `node -e` 跑）：

```js
const { spawn } = require('child_process')
const child = spawn('bash', ['-c', "sleep 20; printf x > /tmp/marker"], {
  windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
})
const t0 = Date.now()
setTimeout(() => {
  // 这就是修复前 onAbort 做的全部事情
  spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).unref()
  console.log(`taskkill 已发出，当前 +${Date.now() - t0}ms`)
}, 200)
child.on('close', () => console.log(`close 于 +${Date.now() - t0}ms`))  // 修复前：20676ms
```

上面这段是**修复前**的形态（只 taskkill）。实测：

- 只 taskkill：`taskkill 已发出 +223ms`，`close 于 +20676ms` —— 睡满 20s 才返回
- 加上 `child.stdout.destroy(); child.stderr.destroy()`：`close 于 +880ms`

（文档内两项均有实测记录，改自本机 Windows + Git Bash。）

## 三、根因（实测证据）

### 3.1 taskkill 报告"成功终止"，孙进程却活着

探针直接复刻 `killTree` 的调用形态，前后各列一次 `tasklist`：

```
[Q4] bash pid=42080
[Q4] 杀之前 sleep = ["sleep.exe 43884 Console 1 10,360 K"]
[Q4] taskkill stdout = 成功: 已终止 PID 12064 (属于 PID 28364 子进程)的进程。
                      成功: 已终止 PID 28364 (属于 PID 43848 子进程)的进程。
[Q4] 杀之后 sleep = ["sleep.exe 43884 Console 1 10,360 K"]   ← 同一个 PID，没死
[Q4] 杀之后 bash  = […… 42080 已消失]
```

`taskkill /T /F` 报告成功，但 **`sleep` 43884 存活**；而直接子进程 bash 确实被杀掉了。

### 3.2 孤儿握着管道 ⇒ `'close'` 等到命令跑完

- 复合命令 `sleep 25; printf x > f`（bash 必须 fork）：abort 后 4 秒仍有 **1 个** `sleep.exe` 存活，`close` 于 **+25674ms** 到达（≈ 睡满 25s）。
- 单命令 `sleep 25`（bash 会 exec 掉自己）：abort 后存活 **0 个**，瞬间返回。

### 3.3 因此二者缺一不可

只 destroy 不杀树也不行——直接子进程没死，`'close'` 同样不来（这条也实测过，见 §6）。

## 四、为什么长期没被发现

复合命令与单命令的行为差异是关键：

| 命令形态 | bash 的行为 | 有无孙进程 | 取消表现 |
|---|---|---|---|
| `sleep 20`（单条简单命令） | bash **exec 掉自己**，进程替换 | 无 | 正常，瞬间返回 |
| `sleep 20; printf …`（复合） | bash 必须 **fork** | 有 | **挂满整个命令时长** |

而历史用例恰好一直用的是单条 `sleep N`，所以这个缺陷在测试里从不显现；加上早期偶发的红灯被归因为"高负载下杀得慢"，就一直被当成 flaky 压着。**但真实场景用的几乎都是复合命令**（`npm ci && npm run build`、`grep x | tail`）。

## 五、修法

```diff
-        const onAbort = (): void => killTree(child.pid)
+        // 取消 = 尽力杀树 + **立刻切断 stdio**，二者缺一回合就被拖住（Y6 实测）：
+        // - 只杀树不 destroy：Windows 上 taskkill /T 打不到 MSYS fork 出的孙进程，
+        //   孙进程握着继承去的管道句柄，'close' 要等它自然退出——实测拖满 60s；
+        // - 只 destroy 不杀树：直接子进程没死，'close' 依然不来（同样实测）。
+        const onAbort = (): void => {
+          killTree(child.pid)
+          child.stdout?.destroy()
+          child.stderr?.destroy()
+        }
```

`killTree` 的 JSDoc 同步写明"杀不到孙进程"这一已知局限，避免以后有人再假设它是完整的。

## 六、反向验证（证明测试判据真的有效）

新判据不是耗时，而是**标记文件**：命令写成 `sleep 60; printf x > marker`——只有自然跑完才会落标记，断言标记不存在即"执行被中止"。

摘掉 `killTree` 后，该用例如实失败：

```
× bash 工具 > 取消信号到达时杀掉子进程并抛错（不挂住回合） 60752ms
  → 标记存在说明进程未被杀死，命令跑完了 60s（实际耗时 60736ms）: expected true to be false
```

另加了正向对照用例（不取消、验证命令确实会落标记），防止"写标记的命令本身失效 ⇒ 永远通过"的空断言。

## 七、残余与已知局限（F-04）

- **孙进程会残留成孤儿**，活到命令自然结束。彻底收殓需要原生 Job Object API（Windows）或 `detached` + 进程组 kill（POSIX）——前者在**零运行时依赖**约束下不可得，后者要改 spawn 语义、风险不可控。取舍是**"回合立即返回"优先于"进程立即消失"**：用户能感知的挂死已消除，残留只是后台进程。
- **POSIX 侧同样只信号到 shell 本身**（`process.kill(pid, 'SIGTERM')`），孙进程一样会残留，只是 POSIX 下它们通常不握 Node 的管道句柄。
- **`'close'` 仍可能在极端环境下变慢**：历史上观察到过 21.3s / >50s 的离群值（那些是**单**命令，与本次根因不同，疑为 taskkill spawn 被磁盘/杀软等因素排队）。修复后它们不再让门禁变红（用例不再断言耗时），但如果真发生，**回合仍会等那么久**。

## 八、可选的后续加固（未做，供取舍）

1. **有界等待**：abort 后若 `'close'` 在 N 秒（如 2s）内未到，直接以取消错误收尾，不再等进程。可彻底切断"环境偶发慢 ⇒ 回合挂住"这条路径，代价是多一个定时器和一条"可能提前返回"的分支。
2. **POSIX 进程组 kill**：spawn 加 `detached: true`，kill 改用 `process.kill(-pid, 'SIGTERM')`，可真正杀净孙进程。代价是改动 spawn 语义（影响全部 bash 调用），且本机是 Windows 无法实测，故未纳入本次改动。

## 九、验证

- 门禁：空闲 2 轮 + **20 核全部打满 1 轮**，全量 **590 例**全绿（589 → 590，多的是正向对照）；typecheck / lint 干净。
- 取消用例耗时：**60.7s → 0.97s**。
- 5 例探针全部跑完即删，`git status` 无残留。
- **2026-10-19 复核（外部 review）**：重跑正反探针，仅 `taskkill` 为 **20633ms**、加 `destroy()` 为 **884ms**（sleep 20s 口径），与上文 20.7s / 0.88s 一致；`bash.test.ts` 取消用例在全量门禁中 **951ms** 返回。结论：修复在工作区生效，行为与文档描述一致。

## 十、待办

改动**尚未提交**。建议单独成笔（不与 08 的 `feat` 混在一起），沿用 07 时的先例 `160d402 fix(tools)`：

```
fix(tools): bash 取消不再被残留孙进程挂住
```

范围：`src/tools/builtin/bash.ts`、`src/tools/builtin/bash.test.ts`、`docs/design/05-tools.md`（§7 Y6）、本文件、`docs/PROGRESS.md`（F-04）。

## 关联

- `docs/design/05-tools.md` §7 偏离记录 **Y6**（含前两次 Y4 / Y5 加宽耗时上界失败的完整历史）
- `docs/PROGRESS.md` 遗留与阻塞（补充）**F-04**
- 历史提交：`160d402 fix(tools): bash 取消用例不再依赖墙上时钟`（那一轮只改了测试阈值，未触及本缺陷）
