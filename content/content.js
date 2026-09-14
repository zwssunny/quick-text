// content script:焦点跟踪 + Shadow DOM 浮动面板 + 文字插入
// 由 background 通过 chrome.scripting 按需注入,可能重复注入 → __qtLoaded 幂等守卫
'use strict';

(() => {
  if (window.__qtLoaded) return;
  window.__qtLoaded = true;

  const PANEL_WIDTH = 320;
  const LIST_LIMIT = 50;
  const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', 'email', 'number']);

  // ---------- 状态 ----------
  let lastEditable = null; // 最近聚焦过的可编辑元素
  let savedRange = null;   // contenteditable 失焦时保存的光标位置
  let host = null;         // 面板宿主(shadow host)
  let ui = null;           // 面板内部元素引用
  let mirror = null;       // caret 坐标测量用的镜像 div
  let state = freshState();

  function freshState() {
    return {
      target: null,      // { el, kind, range }
      copyMode: false,   // 无可编辑目标时:点条目 = 复制到剪贴板
      snippets: [],      // 全量条目(每次打开现读 storage)
      filtered: [],      // 过滤后条目
      sel: -1,           // 高亮索引
      query: '',
      lastPoint: null,   // 面板定位点(数据异步到达后重定位用)
      copyTimer: 0,
    };
  }

  // ---------- 可编辑判定 ----------
  function isTextEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.isContentEditable) return true;
    const tag = el.localName;
    if (tag === 'textarea') return !el.readOnly && !el.disabled;
    if (tag === 'input') {
      const type = (el.type || 'text').toLowerCase();
      return TEXT_INPUT_TYPES.has(type) && !el.readOnly && !el.disabled;
    }
    return false;
  }

  function kindOf(el) {
    if (el.localName === 'textarea') return 'textarea';
    if (el.localName === 'input') return 'input';
    return 'contenteditable';
  }

  // ---------- 焦点跟踪 ----------
  document.addEventListener('focusin', (e) => {
    if (isTextEditable(e.target)) lastEditable = e.target;
  }, true);

  document.addEventListener('focusout', (e) => {
    // 面板打开后焦点转移到面板搜索框,页面 selection 会丢失 → contenteditable 失焦时保存 Range
    const t = e.target;
    if (t && t.nodeType === 1 && kindOf(t) === 'contenteditable') {
      const sel = document.getSelection();
      if (sel && sel.rangeCount > 0) {
        const r = sel.getRangeAt(0);
        if (t.contains(r.commonAncestorContainer)) savedRange = r.cloneRange();
      }
    }
  }, true);

  // ---------- 目标解析(兜底链) ----------
  function resolveTarget() {
    const ae = document.activeElement;
    // 焦点在 iframe 上 → 目标属于那个 frame,本 frame 不参与(避免双面板)
    if (ae && ae.localName === 'iframe') return null;
    if (isTextEditable(ae)) return makeTarget(ae);
    if (lastEditable && lastEditable.isConnected && isTextEditable(lastEditable)) {
      return makeTarget(lastEditable);
    }
    const sel = document.getSelection();
    if (sel && sel.rangeCount > 0) {
      const node = sel.getRangeAt(0).commonAncestorContainer;
      let el = node && (node.nodeType === 1 ? node : node.parentElement);
      while (el && el !== document.documentElement) {
        if (isTextEditable(el)) return makeTarget(el);
        el = el.parentElement;
      }
    }
    return null;
  }

  function makeTarget(el) {
    const t = { el, kind: kindOf(el), range: null };
    if (t.kind === 'contenteditable') {
      // 打开面板的瞬间快照光标位置(随后焦点会进面板搜索框)
      const sel = document.getSelection();
      if (sel && sel.rangeCount > 0) {
        const r = sel.getRangeAt(0);
        if (el.contains(r.commonAncestorContainer)) t.range = r.cloneRange();
      }
      if (!t.range && savedRange && el.contains(savedRange.commonAncestorContainer)) {
        t.range = savedRange.cloneRange();
      }
      if (!t.range) {
        const r = document.createRange();
        r.selectNodeContents(el);
        r.collapse(false); // 兜底:放到末尾
        t.range = r;
      }
    }
    return t;
  }

  // ---------- 面板 UI(Shadow DOM 隔离样式) ----------
  const PANEL_CSS = `
    * { box-sizing: border-box; margin: 0; padding: 0; }
    [hidden] { display: none !important; }
    .qt-panel {
      --bg: #ffffff; --fg: #1f2328; --muted: #6b7280; --line: #e5e7eb;
      --accent: #4f6bed; --accent-bg: #eef1fd;
      width: ${PANEL_WIDTH}px; max-width: calc(100vw - 16px);
      font: 13px/1.5 -apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif;
      background: var(--bg); color: var(--fg);
      border: 1px solid var(--line); border-radius: 10px;
      box-shadow: 0 8px 28px rgba(0, 0, 0, 0.18);
      overflow: hidden;
    }
    @media (prefers-color-scheme: dark) {
      .qt-panel {
        --bg: #26282e; --fg: #e6e6e6; --muted: #9aa0a8; --line: #3a3d44;
        --accent: #7c93ff; --accent-bg: #31384f;
      }
    }
    .qt-search {
      width: 100%; padding: 9px 12px; border: none; outline: none;
      border-bottom: 1px solid var(--line);
      font: inherit; color: var(--fg); background: var(--bg);
    }
    .qt-search::placeholder { color: var(--muted); }
    .qt-banner {
      padding: 6px 12px; font-size: 12px; color: var(--muted);
      background: rgba(127, 127, 127, 0.08); border-bottom: 1px solid var(--line);
    }
    .qt-list { list-style: none; max-height: 264px; overflow-y: auto; position: relative; }
    .qt-item { padding: 7px 12px; cursor: pointer; border-bottom: 1px solid var(--line); }
    .qt-item:last-child { border-bottom: none; }
    .qt-item.sel { background: var(--accent-bg); }
    .qt-item .t { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .qt-item .p {
      color: var(--muted); font-size: 12px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .qt-empty { padding: 18px 12px; text-align: center; color: var(--muted); }
    .qt-footer {
      padding: 5px 12px; font-size: 11px; color: var(--muted);
      border-top: 1px solid var(--line);
      display: flex; justify-content: space-between; gap: 8px;
    }
    .qt-toast { padding: 10px 12px; text-align: center; color: #fff; background: var(--accent); font-size: 12px; }
  `;

  function buildPanel() {
    host = document.createElement('div');
    host.style.cssText =
      'all:initial; position:fixed; z-index:2147483647; left:0; top:0; visibility:hidden;';
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = PANEL_CSS;
    const panel = document.createElement('div');
    panel.className = 'qt-panel';
    panel.innerHTML =
      '<input class="qt-search" type="text" placeholder="输入关键字过滤…" spellcheck="false" autocomplete="off">' +
      '<div class="qt-banner" hidden></div>' +
      '<ul class="qt-list"></ul>' +
      '<div class="qt-empty" hidden>没有匹配的条目</div>' +
      '<div class="qt-footer"><span>↑↓ 选择 · Enter 插入 · Esc 关闭</span><span class="qt-count"></span></div>' +
      '<div class="qt-toast" hidden></div>';
    root.append(style, panel);
    // append 到 documentElement(避免 body 被框架重渲染时连坐)
    (document.body || document.documentElement).appendChild(host);
    ui = {
      panel,
      search: panel.querySelector('.qt-search'),
      banner: panel.querySelector('.qt-banner'),
      list: panel.querySelector('.qt-list'),
      empty: panel.querySelector('.qt-empty'),
      count: panel.querySelector('.qt-count'),
      toast: panel.querySelector('.qt-toast'),
    };
    bindPanelEvents();
  }

  function bindPanelEvents() {
    // 阻止面板内键盘/输入事件冒泡到页面(避免触发网页自身的快捷键/监听器)
    for (const type of [
      'keydown', 'keyup', 'keypress', 'input',
      'compositionstart', 'compositionupdate', 'compositionend',
    ]) {
      host.addEventListener(type, (e) => e.stopPropagation());
    }
    ui.search.addEventListener('input', () => {
      if (!host) return;
      state.query = ui.search.value;
      applyFilter();
    });
    ui.search.addEventListener('keydown', onSearchKeydown);
    // mousedown + preventDefault:插入时不把焦点从搜索框抢走(插入逻辑自己 focus 目标)
    ui.list.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (!host) return;
      const li = e.target.closest('li.qt-item');
      if (!li) return;
      const idx = Number(li.dataset.i);
      if (idx >= 0 && idx < state.filtered.length) {
        state.sel = idx;
        highlightSel();
        chooseItem(state.filtered[idx]);
      }
    });
    ui.list.addEventListener('mousemove', (e) => {
      if (!host) return;
      const li = e.target.closest('li.qt-item');
      if (!li) return;
      const idx = Number(li.dataset.i);
      if (idx >= 0 && idx !== state.sel) {
        state.sel = idx;
        highlightSel();
      }
    });
  }

  function onSearchKeydown(e) {
    if (!host) return;
    if (e.isComposing || e.keyCode === 229) return; // 输入法合成中,放行(中文过滤必须)
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveSel(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveSel(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = state.filtered[state.sel];
      if (item) chooseItem(item);
    }
    // Escape 由 document 捕获层统一处理
  }

  // ---------- 过滤与渲染 ----------
  function applyFilter() {
    const q = state.query.trim().toLowerCase();
    const tokens = q ? q.split(/\s+/) : [];
    let list = state.snippets;
    if (tokens.length) {
      list = list.filter((s) => {
        const hay = (
          (s.title || '') + '\n' + (s.text || '') + '\n' + (s.keywords || []).join('\n')
        ).toLowerCase();
        return tokens.every((t) => hay.includes(t));
      });
    }
    state.filtered = list.slice(0, LIST_LIMIT);
    state.sel = state.filtered.length ? 0 : -1;
    renderList();
  }

  function firstLine(text) {
    return (text || '').split('\n')[0];
  }

  function renderList() {
    const frag = document.createDocumentFragment();
    state.filtered.forEach((s, i) => {
      const li = document.createElement('li');
      li.className = 'qt-item' + (i === state.sel ? ' sel' : '');
      li.dataset.i = String(i);
      const t = document.createElement('div');
      t.className = 't';
      t.textContent = s.title || firstLine(s.text) || '(空)';
      li.appendChild(t);
      if (s.title) {
        const p = document.createElement('div');
        p.className = 'p';
        p.textContent = firstLine(s.text);
        li.appendChild(p);
      }
      frag.appendChild(li);
    });
    ui.list.replaceChildren(frag);
    ui.empty.hidden = state.filtered.length > 0;
    ui.list.hidden = state.filtered.length === 0;
    ui.count.textContent =
      state.filtered.length < state.snippets.length
        ? `${state.filtered.length}/${state.snippets.length}`
        : `${state.snippets.length} 条`;
  }

  function highlightSel() {
    const items = ui.list.children;
    for (let i = 0; i < items.length; i++) items[i].classList.toggle('sel', i === state.sel);
    const cur = items[state.sel];
    if (cur) {
      // 手动滚动(不用 scrollIntoView,避免牵连页面滚动)
      const l = ui.list;
      const top = cur.offsetTop;
      const bottom = top + cur.offsetHeight;
      if (top < l.scrollTop) l.scrollTop = top;
      else if (bottom > l.scrollTop + l.clientHeight) l.scrollTop = bottom - l.clientHeight;
    }
  }

  function moveSel(delta) {
    const n = state.filtered.length;
    if (!n) return;
    state.sel = (((state.sel + delta) % n) + n) % n;
    highlightSel();
  }

  // ---------- 定位 ----------
  function getCaretPoint(target) {
    try {
      if (!target) throw new Error('no target');
      if (target.kind === 'contenteditable') return caretFromRange(target.range);
      return caretFromMirror(target.el);
    } catch (e) {
      /* 兜底:元素矩形 */
    }
    try {
      const r = target.el.getBoundingClientRect();
      return { x: r.left + 8, top: r.top, bottom: Math.min(r.bottom, r.top + 36) };
    } catch (e2) {
      return {
        x: Math.max(8, window.innerWidth / 2 - PANEL_WIDTH / 2),
        top: window.innerHeight / 2,
        bottom: window.innerHeight / 2 + 20,
      };
    }
  }

  function caretFromRange(range) {
    if (!range) throw new Error('no range');
    const r = range.cloneRange();
    r.collapse(false); // 折叠到光标末端
    let rect = r.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0 && rect.top === 0 && rect.left === 0)) {
      // 空块/空行的已知坑:临时插一个零宽 span 测量
      const span = document.createElement('span');
      span.textContent = '\u200b';
      r.insertNode(span);
      rect = span.getBoundingClientRect();
      const parent = span.parentNode;
      span.remove();
      if (parent && parent.normalize) parent.normalize();
    }
    if (!rect) throw new Error('no rect');
    return { x: rect.left, top: rect.top, bottom: rect.bottom || rect.top + 18 };
  }

  // input/textarea 无原生 caret 坐标 API → 镜像 div 法
  const MIRROR_PROPS = [
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant',
    'letterSpacing', 'textTransform', 'wordSpacing', 'textIndent', 'lineHeight',
    'paddingLeft', 'paddingTop', 'paddingRight', 'paddingBottom',
    'overflowWrap', 'wordWrap', 'wordBreak', 'tabSize',
  ];

  function caretFromMirror(el) {
    const cs = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    if (!mirror) {
      mirror = document.createElement('div');
      document.documentElement.appendChild(mirror);
    }
    const m = mirror.style;
    m.cssText =
      'position:absolute;visibility:hidden;pointer-events:none;top:0;left:-9999px;' +
      'overflow:hidden;height:auto;box-sizing:content-box;border:none;';
    m.whiteSpace = el.localName === 'textarea' ? 'pre-wrap' : 'pre';
    m.width = cs.width;
    for (const p of MIRROR_PROPS) {
      try { m[p] = cs[p]; } catch (e) { /* 忽略不支持的属性 */ }
    }
    const pos = typeof el.selectionStart === 'number' ? el.selectionStart : (el.value || '').length;
    mirror.textContent = (el.value || '').slice(0, pos);
    const marker = document.createElement('span');
    marker.textContent = '\u200b';
    mirror.appendChild(marker);
    const bl = parseFloat(cs.borderLeftWidth) || 0;
    const bt = parseFloat(cs.borderTopWidth) || 0;
    const x = rect.left - (el.scrollLeft || 0) + bl + marker.offsetLeft;
    const y = rect.top - (el.scrollTop || 0) + bt + marker.offsetTop;
    const h = marker.offsetHeight || parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2 || 20;
    return { x, top: y, bottom: y + h };
  }

  function placePanel(point) {
    host.style.visibility = 'hidden';
    host.style.left = '0px';
    host.style.top = '0px';
    const W = ui.panel.offsetWidth || PANEL_WIDTH;
    const H = ui.panel.offsetHeight || 200;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x = point.x;
    let y = point.bottom + 6;
    if (y + H > vh - 8) y = point.top - H - 6; // 下方放不下 → 翻到上方
    if (y < 8) y = Math.max(8, vh - H - 8);    // 都放不下 → 贴顶
    x = Math.min(Math.max(8, x), Math.max(8, vw - W - 8)); // 水平贴边收拢
    host.style.left = Math.round(x) + 'px';
    host.style.top = Math.round(y) + 'px';
    host.style.visibility = 'visible';
  }

  // ---------- 全局监听(面板打开期间) ----------
  function onDocKeydown(e) {
    if (!host) return;
    if (e.key === 'Escape' && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      e.stopPropagation();
      closePanel(true);
    }
  }

  function onDocPointerDown(e) {
    if (!host) return;
    if (e.composedPath && e.composedPath().includes(host)) return; // 面板内点击
    closePanel(true);
  }

  function onDocScroll() {
    if (!host) return;
    closePanel(true); // 页面滚动 → 定位失效,按原生下拉的行为直接关闭
  }

  function onDocWheel(e) {
    if (!host) return;
    if (e.composedPath && e.composedPath().includes(host)) return; // 面板内滚列表
    closePanel(true);
  }

  function onResize() {
    if (!host) return;
    closePanel(true);
  }

  function addGlobalListeners() {
    document.addEventListener('keydown', onDocKeydown, true);
    document.addEventListener('pointerdown', onDocPointerDown, true);
    document.addEventListener('scroll', onDocScroll, true);
    document.addEventListener('wheel', onDocWheel, { capture: true, passive: true });
    window.addEventListener('resize', onResize);
  }

  function removeGlobalListeners() {
    document.removeEventListener('keydown', onDocKeydown, true);
    document.removeEventListener('pointerdown', onDocPointerDown, true);
    document.removeEventListener('scroll', onDocScroll, true);
    document.removeEventListener('wheel', onDocWheel, true);
    window.removeEventListener('resize', onResize);
  }

  // ---------- 打开 / 关闭 ----------
  function openPanel(target, copyMode) {
    state = freshState();
    state.target = target;
    state.copyMode = copyMode || !target;
    buildPanel();
    if (state.copyMode) {
      ui.banner.textContent = '未找到输入框 —— 选择条目将复制到剪贴板';
      ui.banner.hidden = false;
    }
    state.lastPoint = getCaretPoint(target);
    placePanel(state.lastPoint);
    addGlobalListeners();
    try { ui.search.focus(); } catch (e) { /* 忽略 */ }
    // 数据异步到达后填充列表并按实际高度重新定位
    chrome.storage.local.get('snippets', (res) => {
      if (!host) return; // 面板已关闭
      const list = res && res.snippets;
      state.snippets = Array.isArray(list)
        ? list.filter((s) => s && typeof s.text === 'string')
        : [];
      applyFilter();
      if (state.lastPoint) placePanel(state.lastPoint);
    });
  }

  function closePanel(restoreFocus) {
    if (!host) return;
    removeGlobalListeners();
    clearTimeout(state.copyTimer);
    const target = state.target;
    host.remove();
    host = null;
    ui = null;
    state = freshState();
    if (restoreFocus && target && target.el.isConnected) {
      try {
        target.el.focus({ preventScroll: true });
        if (target.kind === 'contenteditable' && target.range) {
          const sel = document.getSelection();
          sel.removeAllRanges();
          sel.addRange(target.range);
        }
      } catch (e) { /* 忽略 */ }
    }
  }

  // ---------- 选择条目:插入或复制 ----------
  function chooseItem(item) {
    if (!item) return;
    const text = item.text || '';
    let target = state.target;
    if (!state.copyMode && (!target || !target.el.isConnected)) {
      target = resolveTarget(); // SPA 可能替换了元素 → 重新解析
      state.target = target;
    }
    if (state.copyMode || !target) {
      copyToClipboard(text);
      showToast('已复制到剪贴板');
      return;
    }
    if (insertInto(target, text)) closePanel(false); // 焦点已在目标上
  }

  function insertInto(target, text) {
    const { el, kind } = target;
    try {
      if (kind === 'input' || kind === 'textarea') {
        const out = kind === 'input' ? text.replace(/\r?\n/g, ' ') : text; // 单行框不接受换行
        el.focus(); // selectionStart/End 元素自留,无需恢复
        let ok = false;
        try { ok = document.execCommand('insertText', false, out); } catch (e) { ok = false; }
        if (!ok) {
          // fallback:手动改值 + 派发 input 事件(React 的 value tracker 会对比出差异并触发 onChange)
          const s = typeof el.selectionStart === 'number' ? el.selectionStart : el.value.length;
          const e2 = typeof el.selectionEnd === 'number' ? el.selectionEnd : s;
          el.setRangeText(out, s, e2, 'end');
          el.dispatchEvent(new InputEvent('input', {
            bubbles: true, inputType: 'insertText', data: out,
          }));
        }
      } else {
        el.focus();
        const sel = document.getSelection();
        if (target.range) {
          sel.removeAllRanges();
          sel.addRange(target.range); // 恢复打开面板时保存的光标位置
        }
        let ok = false;
        try { ok = document.execCommand('insertText', false, text); } catch (e) { ok = false; }
        if (!ok) {
          const r = (sel.rangeCount > 0 ? sel.getRangeAt(0) : target.range).cloneRange();
          r.deleteContents();
          const node = document.createTextNode(text);
          r.insertNode(node);
          r.setStartAfter(node);
          r.collapse(true);
          sel.removeAllRanges();
          sel.addRange(r);
          el.dispatchEvent(new InputEvent('input', {
            bubbles: true, inputType: 'insertText', data: text,
          }));
        }
      }
      return true;
    } catch (err) {
      copyToClipboard(text);
      showToast('插入失败,已复制到剪贴板');
      return false;
    }
  }

  function copyToClipboard(text) {
    const fallback = () => {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none;';
        document.documentElement.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      } catch (e) { /* 忽略 */ }
    };
    try {
      const p = navigator.clipboard && navigator.clipboard.writeText(text);
      if (p && p.catch) p.catch(fallback);
      else fallback();
    } catch (e) {
      fallback();
    }
  }

  function showToast(msg) {
    if (!ui) return;
    ui.toast.textContent = msg;
    ui.toast.hidden = false;
    clearTimeout(state.copyTimer);
    state.copyTimer = setTimeout(() => closePanel(true), 900);
  }

  // ---------- 供 background 调用的入口 ----------
  window.__qtOpen = function (opts) {
    opts = opts || {};
    if (host && host.isConnected) {
      // 单例:已打开 → 清空关键字并重新聚焦
      state.query = '';
      if (ui && ui.search) {
        ui.search.value = '';
        applyFilter();
        try { ui.search.focus(); } catch (e) { /* 忽略 */ }
      }
      return { opened: true, again: true };
    }
    const target = resolveTarget();
    if (!target && !opts.copyMode) return { opened: false, reason: 'no-target' };
    openPanel(target, !!opts.copyMode);
    return { opened: true, copyMode: !target };
  };
})();
