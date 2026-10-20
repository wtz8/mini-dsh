/**
 * 页面骨架（内联静态资源，见 `../types.ts` 的 D2）。
 *
 * 两种占位符由服务端在响应前替换：
 * - `__BASE__`：URL 前缀（`options.basePath`，默认空串），用于资源与 API 路径；
 * - `__THEME__`：初始主题（`light` / `dark`），避免首屏闪白。
 *
 * 刻意保持"无框架、无外链、无 emoji"：整个页面只依赖同目录下的
 * `app.css` 与 `app.js`，可完全离线运行。
 */
export const PAGE_HTML = `<!doctype html>
<html lang="zh-CN" data-theme="__THEME__">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>MiniDSH</title>
<link rel="icon" href="__BASE__/assets/mascot.webp">
<link rel="stylesheet" href="__BASE__/assets/app.css">
</head>
<body>

<!-- 氛围层：纯装饰，aria-hidden -->
<div class="ambient" aria-hidden="true">
  <div class="caustics"></div>
  <div class="godrays"></div>
  <div class="bubbles" id="bubbles"></div>
  <div class="school" id="school"></div>
  <svg class="whale-drift" viewBox="0 0 200 120" preserveAspectRatio="xMidYMid meet">
    <g fill="currentColor">
      <path d="M46 74c-14-9-22-19-19-27 4-10 13-8 22-2 7 5 12 12 12 20z"/>
      <path d="M52 78c0-21 20-37 44-35 20 2 34 16 34 34 0 18-15 31-34 31-26 0-44-11-44-30z"/>
      <path d="M100 43c-3-12 2-22 10-27 2 8 0 16-4 21z"/>
      <path d="M80 96c-1 10 3 17 10 18 3-7 1-14-4-19z"/>
    </g>
  </svg>
</div>

<div class="shell">

  <aside class="sidebar">
    <div class="brand" id="brand" title="皮肤总开关">
      <img class="brand-mark" src="__BASE__/assets/mascot.webp" alt="大肥鱼">
    </div>

    <div class="panel meta">
      <div class="row"><span class="k">会话</span><span class="v mono" id="m-session">—</span></div>
      <div class="row"><span class="k">模型</span><span class="v" id="m-model">—</span></div>
      <div class="row"><span class="k">工作目录</span><span class="v mono ellipsis" id="m-cwd">—</span></div>
      <div class="row"><span class="k">回合</span><span class="v" id="m-turns">0</span></div>
      <div class="row"><span class="k">用量</span><span class="v mono" id="m-usage">in 0 · out 0</span></div>
    </div>

    <div class="panel">
      <div class="panel-title">工具</div>
      <ul class="tools" id="m-tools"></ul>
    </div>

    <div class="panel">
      <div class="panel-title">界面</div>
      <label class="switch"><input type="checkbox" id="t-bubbles" checked><span>气泡</span></label>
      <label class="switch"><input type="checkbox" id="t-school" checked><span>鱼群</span></label>
      <label class="switch"><input type="checkbox" id="t-mascot" checked><span>吉祥物</span></label>
      <label class="switch"><input type="checkbox" id="t-reduce"><span>减少动态</span></label>
    </div>

    <div class="brand-foot">
      <span class="dot" id="conn-dot"></span><span id="conn-text">连接中</span>
    </div>
  </aside>

  <main class="main">
    <header class="topbar">
      <div class="tb-left">
        <span class="pill" id="p-provider">—</span>
        <span class="pill" id="p-model">—</span>
      </div>
      <div class="tb-right">
        <button class="ghost" id="btn-clear" title="清空当前视图">清屏</button>
        <button class="ghost" id="btn-theme" title="切换亮/暗主题">暗色</button>
      </div>
    </header>

    <div class="stream" id="stream"></div>

    <div class="compose">
      <div class="fishword" id="fishword"><span class="fw-label">每日鱼语</span><span class="fw-text" id="fw-text"></span></div>
      <div class="approvals" id="approvals"></div>
      <div class="composer">
        <textarea id="input" rows="1" placeholder="说点什么…（Enter 发送，Shift+Enter 换行）"></textarea>
        <button class="primary" id="send">发送</button>
        <button class="danger hidden" id="stop">停止</button>
      </div>
      <div class="hint" id="hint"></div>
    </div>
  </main>
</div>

<div class="mascot" id="mascot">
  <div class="mascot-bubble hidden" id="mascot-bubble"></div>
  <button class="mascot-close hidden" id="mascot-close" title="隐藏吉祥物" aria-label="隐藏吉祥物">
    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3l10 10M13 3L3 13" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>
  </button>
  <button class="mascot-body" id="mascot-body" title="戳一下" aria-label="吉祥物">
    <img src="__BASE__/assets/mascot.webp" alt="">
  </button>
</div>

<script src="__BASE__/assets/app.js" data-base="__BASE__"></script>
</body>
</html>
`
