/**
 * 大肥鱼主题样式表（内联静态资源，见 `../types.ts` 的 D2）。
 *
 * 组织方式：
 * - 令牌层：`--bff-*` 是跨主题共享的尺度/圆角/时长；`--sea-*` 与 `--ink-*` 随主题切换；
 * - 氛围层：海面光晕 / 光柱 / 气泡 / 鱼群 / 鲸影，全部 `aria-hidden` 纯装饰；
 * - 应用层：侧栏、顶栏、消息流、工具卡、审批卡、输入区。
 *
 * 三条约束：
 * 1. **无外链**：不引任何字体、图标库、CDN；所有图形是手写 SVG；
 * 2. **可关停**：气泡 / 鱼群 / 吉祥物 / 动画分别可关（`html[data-reduce]` 一刀切）；
 * 3. **不牺牲可读性**：装饰层永远在内容层之下且 `pointer-events:none`，正文对比度优先。
 */
export const APP_CSS = `
/* ===================== 令牌 ===================== */
:root{
  --bff-accent:#4d6bfe;
  --bff-accent-2:#6d8aff;
  --bff-radius:16px;
  --bff-radius-sm:10px;
  --bff-gap:14px;
  --bff-ease:cubic-bezier(.22,.61,.36,1);
  --bff-dur:.22s;
  --bff-font:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  --bff-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
}

/* 晴海白昼（亮） */
html[data-theme="light"]{
  --sea-1:#eaf6fd; --sea-2:#cde8f8; --sea-3:#a9d6f0;
  --panel:rgba(255,255,255,.80);
  --panel-2:rgba(255,255,255,.62);
  --panel-solid:#ffffff;
  --ink:#0d2c40; --ink-dim:#5b8299; --ink-faint:#8aa8ba;
  --line:rgba(77,107,254,.16);
  --accent:var(--bff-accent);
  --accent-soft:rgba(77,107,254,.10);
  --ok:#0f9d58; --warn:#e08a1e; --err:#d1495b;
  --bubble:rgba(255,255,255,.62);
  --shadow:0 8px 28px rgba(20,60,95,.10);
  color-scheme:light;
}

/* 深海夜（暗） */
html[data-theme="dark"]{
  --sea-1:#04263d; --sea-2:#073354; --sea-3:#0a4269;
  --panel:rgba(8,40,64,.74);
  --panel-2:rgba(8,40,64,.56);
  --panel-solid:#0a2c47;
  --ink:#e2f3fc; --ink-dim:#8db6cf; --ink-faint:#6e94ac;
  --line:rgba(120,180,230,.20);
  --accent:var(--bff-accent-2);
  --accent-soft:rgba(109,138,255,.16);
  --ok:#4ade80; --warn:#fbbf24; --err:#fb7185;
  --bubble:rgba(160,210,240,.30);
  --shadow:0 8px 30px rgba(0,10,25,.45);
  color-scheme:dark;
}

*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{
  font-family:var(--bff-font);
  color:var(--ink);
  background:
    radial-gradient(1200px 700px at 12% -10%, var(--sea-3) 0%, transparent 60%),
    linear-gradient(180deg, var(--sea-1) 0%, var(--sea-2) 55%, var(--sea-1) 100%);
  background-attachment:fixed;
  overflow:hidden;
}
.mono{font-family:var(--bff-mono)}
.ellipsis{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hidden{display:none !important}

/* ===================== 氛围层 ===================== */
.ambient{position:fixed;inset:0;pointer-events:none;z-index:0;overflow:hidden;color:var(--accent)}

/* 海面光晕：几团缓慢漂移的柔光 */
.caustics{
  position:absolute;inset:-20%;
  background:
    radial-gradient(420px 260px at 20% 18%, var(--bubble) 0%, transparent 70%),
    radial-gradient(360px 220px at 72% 12%, var(--accent-soft) 0%, transparent 70%),
    radial-gradient(520px 300px at 88% 78%, var(--bubble) 0%, transparent 72%),
    radial-gradient(380px 240px at 8% 82%, var(--accent-soft) 0%, transparent 70%);
  opacity:.9;
  animation:drift 34s var(--bff-ease) infinite alternate;
  will-change:transform;
}
@keyframes drift{
  0%{transform:translate3d(0,0,0) scale(1)}
  50%{transform:translate3d(2%,-1.5%,0) scale(1.06)}
  100%{transform:translate3d(-1.5%,2%,0) scale(1.02)}
}

/* 光柱：从海面斜射下来的几道 */
.godrays{
  position:absolute;left:-10%;right:-10%;top:-30%;height:130%;
  background:linear-gradient(105deg,
    transparent 0 12%, var(--bubble) 12% 14%, transparent 14% 26%,
    var(--bubble) 26% 27.5%, transparent 27.5% 44%,
    var(--bubble) 44% 46.5%, transparent 46.5% 100%);
  opacity:.35;
  transform:rotate(-6deg);
  animation:rays 18s ease-in-out infinite alternate;
  will-change:opacity,transform;
}
@keyframes rays{
  0%{opacity:.22;transform:rotate(-6deg) translateX(-2%)}
  100%{opacity:.42;transform:rotate(-4deg) translateX(2%)}
}

/* 气泡：元素由 JS 注入，CSS 只负责上升（类名刻意不叫 .bubble——那是消息气泡，撞名会让消息脱离文档流） */
.bubbles{position:absolute;inset:0}
.float-bubble{
  position:absolute;bottom:-8vh;border-radius:50%;
  background:radial-gradient(circle at 32% 28%, rgba(255,255,255,.95), rgba(255,255,255,.12) 58%, rgba(255,255,255,.05) 100%);
  border:1px solid rgba(255,255,255,.45);
  animation:rise linear infinite;
  will-change:transform,opacity;
}
html[data-theme="dark"] .float-bubble{
  background:radial-gradient(circle at 32% 28%, rgba(190,225,250,.85), rgba(150,200,235,.12) 58%, rgba(140,190,230,.05) 100%);
  border-color:rgba(170,215,245,.32);
}
@keyframes rise{
  0%{transform:translate3d(0,10vh,0) scale(.7);opacity:0}
  12%{opacity:.85}
  80%{opacity:.55}
  100%{transform:translate3d(var(--bx,12px),-112vh,0) scale(1.12);opacity:0}
}

/* 鱼群：元素由 JS 注入 */
.school{position:absolute;inset:0}
.fish{position:absolute;color:var(--accent);opacity:.42;animation:swim linear infinite;will-change:transform}
.fish svg{display:block;width:100%;height:100%}
.fish.rev svg{transform:scaleX(-1)}
html[data-theme="dark"] .fish{opacity:.34}
@keyframes swim{
  0%{transform:translate3d(-14vw,0,0)}
  100%{transform:translate3d(114vw,0,0)}
}

/* 远处鲸影：极淡，只在水体下半部缓慢横移 */
.whale-drift{
  position:absolute;bottom:6%;left:-20%;width:44vw;min-width:320px;
  color:var(--accent);opacity:.10;
  animation:whale 62s linear infinite;
  will-change:transform;
}
html[data-theme="dark"] .whale-drift{opacity:.09}
@keyframes whale{
  0%{transform:translate3d(-40%,0,0)}
  100%{transform:translate3d(320%,0,0)}
}

/* ===================== 骨架 ===================== */
.shell{position:relative;z-index:1;display:flex;height:100vh;gap:0}

.sidebar{
  width:250px;flex:0 0 250px;display:flex;flex-direction:column;gap:var(--bff-gap);
  padding:18px 16px;overflow-y:auto;
  background:linear-gradient(180deg,var(--panel-2),var(--panel));
  backdrop-filter:blur(14px);
  border-right:1px solid var(--line);
}

/* 品牌：左上角吉祥物头像（无字标），同时是皮肤总开关 */
.brand{display:flex;align-items:center;justify-content:center;cursor:pointer;user-select:none;
  padding:6px 4px;border-radius:12px;transition:background var(--bff-dur) var(--bff-ease)}
.brand:hover{background:var(--accent-soft)}
.brand-mark{width:52px;height:52px;flex:0 0 52px;border-radius:50%;object-fit:cover;
  background:#eaf4fb;border:2px solid var(--accent-soft);box-shadow:var(--shadow)}

.panel{
  background:var(--panel);border:1px solid var(--line);border-radius:var(--bff-radius);
  padding:12px 13px;box-shadow:var(--shadow);
}
.panel-title{font-size:11px;font-weight:650;color:var(--ink-faint);letter-spacing:1.2px;margin-bottom:9px}

.meta .row{display:flex;align-items:baseline;gap:8px;padding:4px 0;font-size:12px}
.meta .k{color:var(--ink-faint);flex:0 0 52px}
.meta .v{color:var(--ink);min-width:0;flex:1}

.tools{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:6px}
.tools li{font-family:var(--bff-mono);font-size:11px;padding:3px 8px;border-radius:999px;
  background:var(--accent-soft);color:var(--ink-dim);border:1px solid var(--line)}

.switch{display:flex;align-items:center;gap:8px;padding:4px 0;font-size:12px;color:var(--ink-dim);cursor:pointer}
.switch input{accent-color:var(--accent);width:14px;height:14px;cursor:pointer}

.brand-foot{margin-top:auto;display:flex;align-items:center;gap:7px;font-size:11px;color:var(--ink-faint);padding:0 4px}
.dot{width:7px;height:7px;border-radius:50%;background:var(--ink-faint);flex:0 0 7px}
.dot.on{background:var(--ok);box-shadow:0 0 0 3px color-mix(in srgb, var(--ok) 22%, transparent)}
.dot.off{background:var(--err)}

/* ===================== 主区 ===================== */
.main{flex:1;display:flex;flex-direction:column;min-width:0}

.topbar{
  flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;gap:12px;
  padding:11px 20px;border-bottom:1px solid var(--line);
  background:linear-gradient(180deg,var(--panel-2),transparent);
  backdrop-filter:blur(10px);
}
.tb-left,.tb-right{display:flex;align-items:center;gap:8px;min-width:0}
.pill{font-size:11px;padding:4px 10px;border-radius:999px;background:var(--accent-soft);
  color:var(--ink-dim);border:1px solid var(--line);white-space:nowrap}

button{font-family:inherit;font-size:12px;cursor:pointer;border-radius:999px;border:1px solid var(--line);
  background:var(--panel);color:var(--ink-dim);padding:6px 14px;
  transition:background var(--bff-dur) var(--bff-ease),color var(--bff-dur) var(--bff-ease),transform var(--bff-dur) var(--bff-ease)}
button:hover:not(:disabled){background:var(--accent-soft);color:var(--ink)}
button:active:not(:disabled){transform:translateY(1px)}
button:disabled{opacity:.45;cursor:not-allowed}
button.primary{background:var(--accent);color:#fff;border-color:transparent;font-weight:600}
button.primary:hover:not(:disabled){filter:brightness(1.08);color:#fff}
button.danger{background:var(--err);color:#fff;border-color:transparent;font-weight:600}
button.danger:hover:not(:disabled){filter:brightness(1.08);color:#fff}
.ghost{padding:5px 12px}

/* 消息流 */
.stream{flex:1;overflow-y:auto;padding:24px 20px 8px;display:flex;flex-direction:column;gap:16px;scroll-behavior:smooth}
.stream::-webkit-scrollbar{width:9px}
.stream::-webkit-scrollbar-thumb{background:var(--line);border-radius:9px}
.stream::-webkit-scrollbar-track{background:transparent}

.empty{margin:auto;max-width:430px;text-align:center;color:var(--ink-faint);line-height:1.85}
.empty-mark{width:148px;height:148px;object-fit:contain;margin-bottom:6px;
  filter:drop-shadow(0 10px 22px rgba(25,70,120,.22))}
.empty h2{margin:0 0 8px;font-size:15px;font-weight:600;color:var(--ink-dim)}
.empty code{font-family:var(--bff-mono);font-size:11px;background:var(--accent-soft);padding:2px 6px;border-radius:6px}

.msg{display:flex;flex-direction:column;gap:6px;max-width:min(760px,100%)}
.msg.user{align-self:flex-end;align-items:flex-end}
.msg.assistant{align-self:flex-start;align-items:flex-start}

.bubble{
  padding:11px 15px;border-radius:var(--bff-radius);line-height:1.72;font-size:13.5px;
  white-space:pre-wrap;word-break:break-word;box-shadow:var(--shadow);
  background:var(--panel-solid);border:1px solid var(--line);
}
.msg.user .bubble{background:var(--accent);color:#fff;border-color:transparent}
.msg.assistant .bubble{background:var(--panel-solid)}

.bubble .caret{
  display:inline-block;width:7px;height:14px;vertical-align:-2px;margin-left:2px;
  background:var(--accent);animation:blink 1s steps(2,start) infinite;
}
@keyframes blink{50%{opacity:0}}

.meta-line{font-size:10.5px;color:var(--ink-faint);font-family:var(--bff-mono);padding:0 3px}

/* 工具卡片 */
.tool{
  border:1px solid var(--line);border-radius:var(--bff-radius-sm);overflow:hidden;
  background:var(--panel);max-width:min(760px,100%);
}
.tool-head{display:flex;align-items:center;gap:9px;padding:8px 12px;cursor:pointer;user-select:none;
  background:var(--panel-2);transition:background var(--bff-dur) var(--bff-ease)}
.tool-head:hover{background:var(--accent-soft)}
.tool-name{font-family:var(--bff-mono);font-size:12px;font-weight:600;color:var(--ink)}
.tool-arrow{width:9px;height:9px;border-right:1.6px solid var(--ink-faint);border-bottom:1.6px solid var(--ink-faint);
  transform:rotate(-45deg);transition:transform var(--bff-dur) var(--bff-ease);flex:0 0 9px}
.tool.open .tool-arrow{transform:rotate(45deg)}
.tool-body{display:none;padding:0 12px 11px}
.tool.open .tool-body{display:block}
.tool-body pre{
  margin:8px 0 0;padding:10px 12px;border-radius:8px;overflow-x:auto;
  background:var(--panel-2);border:1px solid var(--line);
  font-family:var(--bff-mono);font-size:11.5px;line-height:1.65;color:var(--ink-dim);
  white-space:pre-wrap;word-break:break-word;max-height:320px;
}
.tool-status{font-size:10.5px;padding:2px 8px;border-radius:999px;font-family:var(--bff-mono)}
.tool-status.run{background:var(--accent-soft);color:var(--accent)}
.tool-status.ok{background:color-mix(in srgb,var(--ok) 16%,transparent);color:var(--ok)}
.tool-status.bad{background:color-mix(in srgb,var(--err) 16%,transparent);color:var(--err)}

/* ===================== 输入区 ===================== */
.compose{flex:0 0 auto;padding:12px 20px 18px;border-top:1px solid var(--line);
  background:linear-gradient(180deg,transparent,var(--panel-2));backdrop-filter:blur(10px)}

/* 每日鱼语：输入框上方的滚动条 */
.fishword{
  display:flex;align-items:center;gap:9px;margin:0 auto 10px;max-width:min(760px,100%);
  font-size:11.5px;color:var(--ink-dim);overflow:hidden;white-space:nowrap;
}
.fw-label{
  flex:0 0 auto;font-size:10px;letter-spacing:1.1px;font-weight:650;color:var(--accent);
  padding:2px 8px;border-radius:999px;background:var(--accent-soft);border:1px solid var(--line);
}
.fw-text{overflow:hidden;text-overflow:ellipsis}

/* 审批卡 */
.approvals{display:flex;flex-direction:column;gap:9px;margin:0 auto 10px;max-width:min(760px,100%)}
.approval{
  border:1px solid color-mix(in srgb,var(--warn) 45%,var(--line));border-radius:var(--bff-radius-sm);
  background:var(--panel-solid);padding:11px 13px;
}
.ap-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:7px}
.ap-title{font-size:12px;font-weight:650}
.ap-title .nm{font-family:var(--bff-mono);color:var(--accent)}
.ap-wait{font-size:10.5px;color:var(--ink-faint);font-family:var(--bff-mono)}
.ap-args{
  margin:0 0 10px;padding:9px 11px;border-radius:8px;background:var(--panel-2);
  border:1px solid var(--line);font-family:var(--bff-mono);font-size:11.5px;line-height:1.65;
  color:var(--ink-dim);white-space:pre-wrap;word-break:break-word;max-height:190px;overflow:auto;
}
.ap-actions{display:flex;gap:8px;justify-content:flex-end}

/* 输入行 */
.composer{display:flex;align-items:flex-end;gap:10px;max-width:min(760px,100%);margin:0 auto}
textarea{
  flex:1;resize:none;font-family:inherit;font-size:13.5px;line-height:1.65;color:var(--ink);
  background:var(--panel-solid);border:1px solid var(--line);border-radius:var(--bff-radius);
  padding:11px 14px;max-height:190px;outline:none;
  transition:border-color var(--bff-dur) var(--bff-ease),box-shadow var(--bff-dur) var(--bff-ease);
}
textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
textarea::placeholder{color:var(--ink-faint)}

.hint{
  max-width:min(760px,100%);margin:8px auto 0;font-size:11px;color:var(--ink-faint);
  min-height:15px;line-height:1.55;
}
.hint.warn{color:var(--warn)}
.hint.err{color:var(--err)}

/* ===================== 吉祥物 ===================== */
.mascot{position:fixed;right:22px;bottom:20px;z-index:5;display:flex;flex-direction:column;align-items:flex-end;gap:8px}
.mascot-body{
  width:118px;height:118px;padding:0;border:none;background:transparent;
  filter:drop-shadow(0 8px 18px rgba(25,70,120,.20));
  animation:breathe 4.2s var(--bff-ease) infinite;
}
.mascot-body img{width:100%;height:100%;object-fit:contain;display:block}
.mascot-body:hover{filter:drop-shadow(0 10px 22px rgba(25,70,120,.30))}
@keyframes breathe{
  0%,100%{transform:translateY(0) rotate(-.6deg)}
  50%{transform:translateY(-7px) rotate(.6deg)}
}
/* 戳一戳：整体左右摇摆（立绘为整图，无法局部挥手，改为全身晃动） */
.mascot-body.wave{animation:wave .62s var(--bff-ease) 2}
@keyframes wave{
  0%,100%{transform:rotate(0deg) scale(1)}
  35%{transform:rotate(-6deg) scale(1.04)}
  70%{transform:rotate(5deg) scale(1.02)}
}
.mascot-bubble{
  max-width:250px;padding:9px 13px;border-radius:14px 14px 4px 14px;font-size:12px;line-height:1.65;
  background:var(--panel-solid);border:1px solid var(--line);box-shadow:var(--shadow);color:var(--ink);
  animation:pop .26s var(--bff-ease);
}
@keyframes pop{from{opacity:0;transform:translateY(6px) scale(.97)}to{opacity:1;transform:none}}
.mascot-close{
  width:22px;height:22px;padding:0;display:grid;place-items:center;color:var(--ink-faint);
  background:var(--panel-solid);opacity:0;transition:opacity var(--bff-dur) var(--bff-ease);
}
.mascot:hover .mascot-close{opacity:1}
.mascot-close svg{width:11px;height:11px}

/* ===================== 开关落点 ===================== */
html[data-bubbles="0"] .bubbles{display:none}
html[data-school="0"] .school{display:none}
html[data-school="0"] .whale-drift{display:none}
html[data-mascot="0"] .mascot{display:none}
html[data-reduce="1"] *{animation:none !important;transition:none !important;scroll-behavior:auto !important}

/* 窄侧栏自适应 */
@media (max-width:860px){
  .sidebar{width:186px;flex:0 0 186px;padding:14px 11px}
  .stream{padding:16px 13px 6px}
  .compose{padding:10px 13px 14px}
  .mascot-body{width:88px;height:88px}
}
`
