/**
 * 前端逻辑（内联静态资源，见 `../types.ts` 的 D2）。
 *
 * 刻意写成 ES5 风格的原生 JS：无构建、无框架、无 polyfill，直接 `<script>` 引入。
 *
 * 状态约定（灵魂 #2 的客户端映射）：
 * - **历史**不保存在内存里——每次重连/刷新都从 `GET /api/state` 重新投影；
 * - 内存里只缓存"正在进行的这一回合"的增量（`streaming`），回合结束即丢弃。
 *
 * 转义提醒：本文件内容是 `assets/client.ts` 的一个模板字符串常量，因此源码里凡是
 * 需要让浏览器看到 `\n` 的地方，都必须写成 `\\n`（本文件已统一处理）。
 */
export const APP_JS = `
(function () {
  'use strict';

  var NL = '\\n';
  var scriptTag = document.getElementById('app-js') || document.querySelector('script[data-base]');
  var BASE = (scriptTag && scriptTag.getAttribute('data-base')) || '';
  var LS = 'bff.';

  /* ---------------- 元素 ---------------- */
  var el = {
    stream: document.getElementById('stream'),
    approvals: document.getElementById('approvals'),
    input: document.getElementById('input'),
    send: document.getElementById('send'),
    stop: document.getElementById('stop'),
    hint: document.getElementById('hint'),
    bubbles: document.getElementById('bubbles'),
    school: document.getElementById('school'),
    connDot: document.getElementById('conn-dot'),
    connText: document.getElementById('conn-text'),
    mascot: document.getElementById('mascot'),
    mascotBody: document.getElementById('mascot-body'),
    mascotBubble: document.getElementById('mascot-bubble'),
    mascotClose: document.getElementById('mascot-close'),
    brand: document.getElementById('brand'),
    fwText: document.getElementById('fw-text'),
    mSession: document.getElementById('m-session'),
    mModel: document.getElementById('m-model'),
    mCwd: document.getElementById('m-cwd'),
    mTurns: document.getElementById('m-turns'),
    mUsage: document.getElementById('m-usage'),
    mTools: document.getElementById('m-tools')
  };

  /* ---------------- 语录 ---------------- */
  var FISHWORDS = [
    '深海里的光，是自己游出来的。',
    '今天也要做一条有方向的鱼。',
    '慢慢游，比较快。',
    '泡泡会破，但海一直在。',
    '别急，先让思路沉一沉。',
    '每条大肥鱼都曾是小小的鱼苗。',
    '逆流的时候，才看得出鳍的力量。',
    '深度求索中，顺手吐个泡。',
    '把复杂的事泡开，就好读了。',
    '水流记得每一次摆尾。'
  ];

  var MASCOT_LINES = [
    '在呢，你说。',
    '这条鱼已经准备好了。',
    '要不要我先读读项目？',
    '深海信号良好。',
    '戳我干嘛，我可是正经吉祥物。',
    '别慌，慢慢来。',
    '今天想改点什么？',
    '思考中……顺便吐个泡。'
  ];

  /* ---------------- 状态 ---------------- */
  var state = {
    sessionId: '—',
    provider: '—',
    model: '—',
    cwd: '—',
    tools: [],
    messages: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    turnCount: 0,
    running: false
  };

  /** 正在进行的回合的增量缓存；回合结束即清空。 */
  var streaming = null;

  /* ---------------- 小工具 ---------------- */
  function byId(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  function getLS(k, d) {
    try { var v = localStorage.getItem(LS + k); return v === null ? d : v; } catch (e) { return d; }
  }
  function setLS(k, v) {
    try { localStorage.setItem(LS + k, String(v)); } catch (e) { /* 隐私模式忽略 */ }
  }

  function nearBottom() {
    var s = el.stream;
    return s.scrollHeight - s.scrollTop - s.clientHeight < 90;
  }
  function scrollBottom() {
    el.stream.scrollTop = el.stream.scrollHeight;
  }

  function setHint(text, kind) {
    el.hint.textContent = text || '';
    el.hint.className = 'hint' + (kind ? ' ' + kind : '');
  }

  async function api(path, body) {
    var init = { method: body === undefined ? 'GET' : 'POST' };
    if (body !== undefined) {
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    var res = await fetch(BASE + path, init);
    var text = await res.text();
    var data = null;
    if (text) { try { data = JSON.parse(text); } catch (e) { data = null; } }
    return { ok: res.ok, status: res.status, data: data };
  }

  function setConn(on) {
    el.connDot.className = 'dot ' + (on ? 'on' : 'off');
    el.connText.textContent = on ? '已连接' : '连接中断';
  }

  /* ---------------- 氛围层生成 ---------------- */
  function buildBubbles() {
    if (!el.bubbles) return;
    var html = '';
    for (var i = 0; i < 20; i++) {
      var size = 5 + Math.random() * 16;
      var left = Math.random() * 100;
      var dur = 11 + Math.random() * 15;
      var delay = -(Math.random() * dur);
      var drift = (Math.random() * 70 - 35).toFixed(1);
      html += '<span class="float-bubble" style="left:' + left.toFixed(2) + '%;width:' + size.toFixed(1) +
        'px;height:' + size.toFixed(1) + 'px;animation-duration:' + dur.toFixed(1) +
        's;animation-delay:' + delay.toFixed(1) + 's;--bx:' + drift + 'px"></span>';
    }
    el.bubbles.innerHTML = html;
  }

  var FISH_SVG =
    '<svg viewBox="0 0 44 20" aria-hidden="true">' +
    '<path d="M1 10c6-8 20-10 28-4l14-5-3 9 3 9-14-5c-8 6-22 4-28-4z" fill="currentColor"/>' +
    '<circle cx="9" cy="8.4" r="1.5" fill="#fff"/></svg>';

  function buildSchool() {
    if (!el.school) return;
    var html = '';
    for (var i = 0; i < 7; i++) {
      var w = 22 + Math.random() * 26;
      var top = 12 + Math.random() * 72;
      var dur = 26 + Math.random() * 30;
      var delay = -(Math.random() * dur);
      var rev = Math.random() < 0.35;
      var anim = rev ? 'swim-rev' : 'swim';
      html += '<span class="fish' + (rev ? ' rev' : '') + '" style="top:' + top.toFixed(1) +
        '%;width:' + w.toFixed(1) + 'px;height:' + (w / 2.2).toFixed(1) +
        'px;animation:' + anim + ' ' + dur.toFixed(1) + 's linear ' + delay.toFixed(1) +
        's infinite">' + FISH_SVG + '</span>';
    }
    el.school.innerHTML = html;
  }

  /* ---------------- 渲染：历史重建 ---------------- */
  function renderMessages(messages) {
    el.stream.innerHTML = '';
    if (!messages || messages.length === 0) {
      el.stream.innerHTML =
        '<div class="empty">' +
        '<img class="empty-mark" src="' + BASE + '/assets/mascot.webp" alt="">' +
        '<h2>MiniDSH</h2>' +
        '<p>插件内核驱动的本地 agent 骨架。说点什么开始一个回合，<br>' +
        '工具调用会在这里展开过程与结果。</p>' +
        '<p>提示：<code>Enter</code> 发送 · <code>Shift+Enter</code> 换行 · <code>Esc</code> 停止</p>' +
        '</div>';
      return;
    }

    // callId → name 索引：tool 消息本身不带工具名，需回溯到发起调用的 assistant 消息
    var names = {};
    for (var i = 0; i < messages.length; i++) {
      var m = messages[i];
      if (m.role === 'assistant' && m.toolCalls) {
        for (var j = 0; j < m.toolCalls.length; j++) {
          names[m.toolCalls[j].id] = m.toolCalls[j].name;
        }
      }
    }

    for (var k = 0; k < messages.length; k++) {
      var msg = messages[k];
      if (msg.role === 'user') {
        el.stream.appendChild(userBlock(msg.content));
      } else if (msg.role === 'assistant') {
        if (msg.content) el.stream.appendChild(assistantBlock(msg.content));
      } else if (msg.role === 'tool') {
        el.stream.appendChild(toolBlock(names[msg.toolCallId] || 'tool', '', true, msg.content));
      }
    }
    scrollBottom();
  }

  function div(cls) {
    var d = document.createElement('div');
    d.className = cls;
    return d;
  }

  function userBlock(text) {
    var w = div('msg user');
    var b = div('bubble');
    b.textContent = text;
    w.appendChild(b);
    return w;
  }

  function assistantBlock(text) {
    var w = div('msg assistant');
    var b = div('bubble');
    b.textContent = text;
    w.appendChild(b);
    return w;
  }

  /** 工具卡片；done 为真时默认展开（历史重建时用它展示结果）。 */
  function toolBlock(name, args, done, result) {
    var w = div('tool' + (done ? ' open' : ''));
    var head = div('tool-head');
    var arrow = div('tool-arrow');
    var nm = div('tool-name');
    nm.textContent = name;
    var st = div('tool-status ' + (done ? 'ok' : 'run'));
    st.textContent = done ? '完成' : '执行中';
    head.appendChild(arrow);
    head.appendChild(nm);
    head.appendChild(st);

    var body = div('tool-body');
    if (args) {
      var pre = document.createElement('pre');
      pre.textContent = args;
      body.appendChild(pre);
    }
    if (result) {
      var pre2 = document.createElement('pre');
      pre2.textContent = result;
      body.appendChild(pre2);
    }

    head.addEventListener('click', function () {
      if (w.className.indexOf('open') >= 0) {
        w.className = w.className.replace(' open', '');
      } else {
        w.className = w.className + ' open';
      }
    });

    w.appendChild(head);
    w.appendChild(body);
    return w;
  }

  /* ---------------- 渲染：流式增量 ---------------- */
  function beginStream() {
    streaming = { text: '', bubble: null, wrapper: null, tools: {} };
    var w = div('msg assistant');
    var b = div('bubble');
    var caret = document.createElement('span');
    caret.className = 'caret';
    b.appendChild(caret);
    w.appendChild(b);
    el.stream.appendChild(w);
    streaming.wrapper = w;
    streaming.bubble = b;
    streaming.caret = caret;
    scrollBottom();
  }

  function appendText(delta) {
    if (!streaming) beginStream();
    streaming.text += delta;
    // 保留末尾光标：文本插到 caret 之前
    streaming.bubble.insertBefore(document.createTextNode(delta), streaming.caret);
    if (nearBottom()) scrollBottom();
  }

  function addTool(callId, name, args) {
    if (!streaming) beginStream();
    var card = toolBlock(name, args, false, '');
    el.stream.appendChild(card);
    streaming.tools[callId] = card;
    if (nearBottom()) scrollBottom();
  }

  function endTool(callId, ok, text, code) {
    if (!streaming || !streaming.tools[callId]) return;
    var card = streaming.tools[callId];
    card.className = card.className.replace(' open', '') + ' open';
    var head = card.firstChild;
    var st = head.lastChild;
    st.className = 'tool-status ' + (ok ? 'ok' : 'bad');
    st.textContent = ok ? '完成' : (code || '失败');
    var body = card.lastChild;
    var pre = document.createElement('pre');
    pre.textContent = text;
    body.appendChild(pre);
    if (nearBottom()) scrollBottom();
  }

  /** 回合收尾：去掉光标；历史以服务端投影为准，此处不自行合并。 */
  function endStream(usage, stepCount, interrupted) {
    if (streaming && streaming.caret && streaming.caret.parentNode) {
      streaming.caret.parentNode.removeChild(streaming.caret);
    }
    // 空输出（如取消发生在首片之前）：留一条提示，避免界面"什么都没发生"
    if (streaming && streaming.text === '') {
      var note = document.createElement('div');
      note.className = 'meta-line';
      note.textContent = interrupted ? '（回合已取消，无输出）' : '（本次无文本输出）';
      el.stream.appendChild(note);
    }
    streaming = null;
    if (usage) renderUsage(usage);
    setRunning(false);
    var tail = ' 步数 ' + String(stepCount);
    if (interrupted) tail += ' · 已中断';
    setHint(tail);
  }

  /* ---------------- 头部与用量 ---------------- */
  function renderUsage(u) {
    state.usage = u;
    var inn = u && u.inputTokens ? u.inputTokens : 0;
    var out = u && u.outputTokens ? u.outputTokens : 0;
    el.mUsage.textContent = 'in ' + String(inn) + ' · out ' + String(out);
  }

  function renderMeta(s) {
    state.sessionId = s.sessionId || '—';
    state.provider = s.provider || '—';
    state.model = s.model || '—';
    state.cwd = s.cwd || '—';
    state.tools = s.tools || [];
    state.messages = s.messages || [];
    state.turnCount = s.turnCount || 0;
    el.mSession.textContent = state.sessionId;
    el.mModel.textContent = state.model;
    el.mCwd.textContent = state.cwd;
    el.mCwd.title = state.cwd;
    el.mTurns.textContent = String(state.turnCount);
    var p = document.getElementById('p-provider');
    var m = document.getElementById('p-model');
    if (p) p.textContent = state.provider;
    if (m) m.textContent = state.model;
    var lis = '';
    for (var i = 0; i < state.tools.length; i++) lis += '<li>' + esc(state.tools[i]) + '</li>';
    el.mTools.innerHTML = lis;
    renderUsage(s.usage);
  }

  /* ---------------- 审批卡片 ---------------- */
  var approvalNodes = {};

  function addApproval(a) {
    if (approvalNodes[a.id]) return;
    var box = document.createElement('div');
    box.className = 'approval';

    var head = document.createElement('div');
    head.className = 'ap-head';
    var title = document.createElement('div');
    title.className = 'ap-title';
    title.innerHTML = '请求执行 <span class="nm">' + esc(a.toolName) + '</span>';
    var wait = document.createElement('div');
    wait.className = 'ap-wait';
    wait.textContent = '等待确认';
    head.appendChild(title);
    head.appendChild(wait);

    var pre = document.createElement('pre');
    pre.className = 'ap-args';
    pre.textContent = prettyArgs(a.args);

    var actions = document.createElement('div');
    actions.className = 'ap-actions';
    var allow = document.createElement('button');
    allow.className = 'primary';
    allow.textContent = '允许';
    var deny = document.createElement('button');
    deny.className = 'danger';
    deny.textContent = '拒绝';

    allow.addEventListener('click', function () { respond(a.id, true); });
    deny.addEventListener('click', function () { respond(a.id, false); });

    actions.appendChild(deny);
    actions.appendChild(allow);

    box.appendChild(head);
    box.appendChild(pre);
    box.appendChild(actions);

    el.approvals.appendChild(box);
    approvalNodes[a.id] = box;
    setHint('有工具在等待你确认');
  }

  function removeApproval(id) {
    var n = approvalNodes[id];
    if (!n) return;
    if (n.parentNode) n.parentNode.removeChild(n);
    delete approvalNodes[id];
    if (Object.keys(approvalNodes).length === 0) setHint('');
  }

  async function respond(id, allow) {
    allow = !!allow;
    // 乐观移除：按钮点了就消失，不等服务端回执（回执只是兜底同步）
    removeApproval(id);
    var r = await api('/api/approve', { id: id, allow: allow });
    if (!r.ok) setHint('审批提交失败（' + r.status + '）', 'err');
  }

  function prettyArgs(args) {
    try {
      return JSON.stringify(args, null, 2);
    } catch (e) {
      return String(args);
    }
  }

  /* ---------------- 发送 / 停止 ---------------- */
  function setRunning(on) {
    state.running = !!on;
    el.send.classList.toggle('hidden', !!on);
    el.stop.classList.toggle('hidden', !on);
    el.input.disabled = !!on;
  }

  async function send() {
    var text = el.input.value.trim();
    if (!text) { setHint('请输入内容', 'warn'); return; }
    el.input.value = '';
    autoGrow();
    el.stream.appendChild(userBlock(text));
    scrollBottom();
    setRunning(true);
    setHint('深度求索中…');
    var r = await api('/api/turn', { text: text });
    if (!r.ok) {
      var why = r.data && r.data.error ? r.data.error : ('HTTP ' + r.status);
      setHint('回合启动失败：' + why, 'err');
      setRunning(false);
    }
  }

  async function stop() {
    setHint('正在停止…');
    var r = await api('/api/cancel', {});
    if (!r.ok) setHint('停止失败（' + r.status + '）', 'err');
  }

  function autoGrow() {
    var t = el.input;
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight, 190) + 'px';
  }

  /* ---------------- 主题与开关 ---------------- */
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    var b = byId('btn-theme');
    if (b) b.textContent = theme === 'dark' ? '亮色' : '暗色';
  }

  function bindToggle(id, key, def) {
    var box = byId(id);
    if (!box) return;
    var raw = getLS(key, def ? '1' : '1');
    box.checked = raw !== '0';
    document.documentElement.setAttribute('data-' + key, box.checked ? '1' : '0');
    box.addEventListener('change', function () {
      setLS(key, box.checked ? '1' : '0');
      document.documentElement.setAttribute('data-' + key, box.checked ? '1' : '0');
    });
  }

  /* ---------------- SSE ---------------- */
  var source = null;
  var buffer = '';

  function handleFrame(raw) {
    var line = raw;
    if (line.charAt(0) === ':') return;          // 心跳注释帧
    if (line.indexOf('data:') !== 0) return;
    var payload = line.slice(5);
    if (payload.charAt(0) === ' ') payload = payload.slice(1);
    if (!payload) return;
    var ev = null;
    try { ev = JSON.parse(payload); } catch (e) { return; }
    if (!ev || typeof ev.type !== 'string') return;
    onEvent(ev);
  }

  function onEvent(ev) {
    var t = ev.type;
    if (t === 'hello') {
      setConn(true);
      return;
    }
    if (t === 'turn-start') {
      setRunning(true);
      beginStream();
      setHint('深度求索中…');
      return;
    }
    if (t === 'text') {
      appendText(ev.delta || '');
      return;
    }
    if (t === 'tool-start') {
      addTool(ev.callId, ev.name, ev.args || '');
      return;
    }
    if (t === 'tool-end') {
      endTool(ev.callId, !!ev.ok, ev.text || '', ev.code);
      return;
    }
    if (t === 'turn-end') {
      endStream(ev.usage, ev.stepCount, !!ev.interrupted);
      refreshState();
      return;
    }
    if (t === 'approval') {
      addApproval(ev.approval);
      return;
    }
    if (t === 'approval-resolved') {
      removeApproval(ev.id);
      return;
    }
    if (t === 'error') {
      setHint(ev.text || '出错了', 'err');
      setRunning(false);
      return;
    }
    if (t === 'log') {
      // 日志只落到控制台，避免污染对话区
      if (window.console && console.log) console.log('[mdsh]', ev.level, ev.text);
      return;
    }
  }

  function connect() {
    if (source) { try { source.close(); } catch (e) {} }
    source = new EventSource(BASE + '/api/events');

    source.onopen = function () { setConn(true); };

    source.onmessage = function (e) {
      // 服务端按行发；浏览器 EventSource 已按空行切分事件，但保险起见再按行拆
      var text = String(e.data || '');
      if (text.indexOf(NL) < 0) { handleFrame('data:' + text); return; }
      var parts = text.split(NL);
      for (var i = 0; i < parts.length; i++) handleFrame('data:' + parts[i]);
    };

    source.onerror = function () {
      setConn(false);
    };
  }

  /* ---------------- 启动 ---------------- */
  async function refreshState() {
    var r = await api('/api/state');
    if (!r.ok || !r.data) return;
    renderMeta(r.data);
    if (!state.running) renderMessages(r.data.messages || []);
    // 待审批以服务端为准：补齐刷新前就挂起的那几条
    var pend = r.data.pendingApprovals || [];
    for (var i = 0; i < pend.length; i++) addApproval(pend[i]);
  }

  function init() {
    var theme = getLS('theme', 'light');
    if (theme !== 'dark' && theme !== 'light') theme = 'light';
    applyTheme(theme);

    bindToggle('t-bubbles', 'bubbles', true);
    bindToggle('t-school', 'school', true);
    bindToggle('t-mascot', 'mascot', true);

    var reduce = byId('t-reduce');
    if (reduce) {
      var rv = getLS('reduce', '0');
      reduce.checked = rv === '1';
      document.documentElement.setAttribute('data-reduce', reduce.checked ? '1' : '0');
      reduce.addEventListener('change', function () {
        setLS('reduce', reduce.checked ? '1' : '0');
        document.documentElement.setAttribute('data-reduce', reduce.checked ? '1' : '0');
      });
    }

    var btnTheme = byId('btn-theme');
    if (btnTheme) {
      btnTheme.addEventListener('click', function () {
        var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        setLS('theme', next);
        applyTheme(next);
      });
    }

    var btnClear = byId('btn-clear');
    if (btnClear) {
      btnClear.addEventListener('click', function () {
        renderMessages([]);
        setHint('已清空当前视图（会话日志不受影响）');
      });
    }

    buildBubbles();
    buildSchool();

    el.send.addEventListener('click', send);
    el.stop.addEventListener('click', stop);

    el.input.addEventListener('input', autoGrow);
    el.input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (!state.running) send();
      } else if (e.key === 'Escape') {
        if (state.running) stop();
      }
    });

    // 每日鱼语轮播
    var fw = byId('fw-text');
    if (fw) {
      var idx = Math.floor(Math.random() * FISHWORDS.length);
      fw.textContent = FISHWORDS[idx];
      setInterval(function () {
        idx = (idx + 1) % FISHWORDS.length;
        fw.textContent = FISHWORDS[idx];
      }, 6000);
    }

    // 吉祥物：单击招手 + 随机语录
    if (el.mascotBody) {
      el.mascotBody.addEventListener('click', function () {
        el.mascotBody.classList.remove('wave');
        // 强制重排以便连续点击时动画能重新触发
        void el.mascotBody.offsetWidth;
        el.mascotBody.classList.add('wave');
        var line = pick(MASCOT_LINES);
        el.mascotBubble.textContent = line;
        el.mascotBubble.classList.remove('hidden');
        clearTimeout(el.mascotBody._t);
        el.mascotBody._t = setTimeout(function () {
          el.mascotBubble.classList.add('hidden');
        }, 4200);
      });
    }
    if (el.mascotClose) {
      el.mascotClose.addEventListener('click', function (e) {
        e.stopPropagation();
        document.documentElement.setAttribute('data-mascot', '0');
        var box = byId('t-mascot');
        if (box) box.checked = false;
        setLS('mascot', '0');
      });
    }

    // 品牌 = 皮肤总开关：整关时撤走全部氛围层
    if (el.brand) {
      el.brand.addEventListener('click', function () {
        var all = ['bubbles', 'school', 'mascot'];
        var key = document.documentElement.getAttribute('data-bubbles') === '0' ? '1' : '0';
        for (var i = 0; i < all.length; i++) {
          document.documentElement.setAttribute('data-' + all[i], key);
          var b = byId('t-' + all[i]);
          if (b) b.checked = key === '1';
          setLS(all[i], key);
        }
      });
    }

    refreshState();
    connect();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
`
