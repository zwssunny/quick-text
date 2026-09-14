// 管理页逻辑:条目 CRUD、上下移、搜索、JSON 导入/导出
// 数据:chrome.storage.local 单 key `snippets`,数组顺序 = 面板显示顺序
'use strict';

const $ = (sel) => document.querySelector(sel);

let all = [];            // 全量条目
let editingId = null;    // 正在编辑的条目 id(null = 新增模式)
let query = '';          // 搜索关键字
let pendingImport = null; // 待确认的导入数据
let toastTimer = 0;

// ---------- 存储 ----------
async function loadSnippets() {
  const { snippets } = await chrome.storage.local.get('snippets');
  all = Array.isArray(snippets) ? snippets.filter((s) => s && typeof s.text === 'string') : [];
}

async function persist() {
  await chrome.storage.local.set({ snippets: all });
}

// ---------- 渲染 ----------
function summarize(text) {
  return (text || '').split('\n')[0].slice(0, 80);
}

function filtered() {
  const q = query.trim().toLowerCase();
  if (!q) return all;
  const tokens = q.split(/\s+/);
  return all.filter((s) => {
    const hay = ((s.title || '') + '\n' + s.text + '\n' + (s.keywords || []).join('\n')).toLowerCase();
    return tokens.every((t) => hay.includes(t));
  });
}

function makeBtn(label, title, action, disabled) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.title = title;
  b.dataset.action = action;
  if (disabled) b.disabled = true;
  return b;
}

function render() {
  const items = filtered();
  const searching = !!query.trim();
  $('#count').textContent = searching ? `${items.length}/${all.length}` : `${all.length} 条`;

  const frag = document.createDocumentFragment();
  items.forEach((s) => {
    const li = document.createElement('li');
    li.className = 'row' + (s.id === editingId ? ' editing' : '');
    li.dataset.id = s.id;

    const main = document.createElement('div');
    main.className = 'main';
    const t = document.createElement('div');
    t.className = 'title';
    t.textContent = s.title || summarize(s.text) || '(空)';
    const p = document.createElement('div');
    p.className = 'preview';
    p.textContent = s.title
      ? summarize(s.text)
      : (s.keywords || []).map((k) => '#' + k).join(' ');
    main.append(t, p);

    const ops = document.createElement('div');
    ops.className = 'ops';
    const idx = all.findIndex((x) => x.id === s.id);
    // 过滤态禁用 ↑↓:避免"在过滤视图里移动却改了全量顺序"的歧义
    ops.append(
      makeBtn('↑', '上移', 'up', searching || idx <= 0),
      makeBtn('↓', '下移', 'down', searching || idx >= all.length - 1),
      makeBtn('✎', '编辑', 'edit', false),
      makeBtn('🗑', '删除', 'del', false)
    );

    li.append(main, ops);
    frag.appendChild(li);
  });

  const list = $('#list');
  list.replaceChildren(frag);

  const empty = $('#empty');
  if (all.length === 0) {
    empty.textContent = '还没有条目,用上面的表单添加第一条吧';
    empty.hidden = false;
  } else if (items.length === 0) {
    empty.textContent = `没有匹配「${query.trim()}」的条目`;
    empty.hidden = false;
  } else {
    empty.hidden = true;
  }
}

// ---------- 表单 ----------
function startEdit(s) {
  editingId = s.id;
  $('#form-heading').textContent = '编辑条目';
  $('#f-title').value = s.title || '';
  $('#f-text').value = s.text;
  $('#f-keywords').value = (s.keywords || []).join(', ');
  $('#form-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('#f-text').focus();
  render();
}

function resetForm() {
  editingId = null;
  $('#form-heading').textContent = '新增条目';
  $('#f-title').value = '';
  $('#f-text').value = '';
  $('#f-keywords').value = '';
  render();
}

function parseKeywords(raw) {
  return raw.split(/[,，、;；]+/).map((s) => s.trim()).filter(Boolean);
}

// ---------- 导出 / 导入 ----------
function stampNow() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function downloadBackup(snippets, namePrefix) {
  const data = { version: 1, exportedAt: Date.now(), snippets };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${namePrefix}-${stampNow()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

function normalizeImported(data) {
  const arr = Array.isArray(data)
    ? data
    : data && Array.isArray(data.snippets)
      ? data.snippets
      : null;
  if (!arr) throw new Error('格式不正确:应为条目数组或 { snippets: [...] }');
  const out = [];
  const seenIds = new Set(all.map((s) => s.id));
  for (const item of arr) {
    if (!item || typeof item.text !== 'string' || !item.text) continue;
    let id = typeof item.id === 'string' && item.id ? item.id : '';
    if (!id || seenIds.has(id)) id = crypto.randomUUID(); // 缺失/重复 id → 重新生成
    seenIds.add(id);
    out.push({
      id,
      title: typeof item.title === 'string' ? item.title : '',
      text: item.text,
      keywords: Array.isArray(item.keywords)
        ? item.keywords.filter((k) => typeof k === 'string')
        : [],
      createdAt: typeof item.createdAt === 'number' ? item.createdAt : Date.now(),
    });
  }
  if (!out.length) throw new Error('文件里没有有效条目(每条需有非空的 text 字段)');
  return out;
}

// ---------- toast ----------
function toast(msg, isError) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = isError ? 'show error' : 'show';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 2400);
}

// ---------- 事件绑定(MV3 CSP:不用内联属性) ----------
$('#search').addEventListener('input', (e) => {
  query = e.target.value;
  render();
});

$('#list').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-action]');
  if (!b || b.disabled) return;
  const li = b.closest('li.row');
  if (!li) return;
  const idx = all.findIndex((s) => s.id === li.dataset.id);
  if (idx < 0) return;
  switch (b.dataset.action) {
    case 'up':
      if (idx > 0) {
        [all[idx - 1], all[idx]] = [all[idx], all[idx - 1]];
        await persist();
        render();
      }
      break;
    case 'down':
      if (idx < all.length - 1) {
        [all[idx + 1], all[idx]] = [all[idx], all[idx + 1]];
        await persist();
        render();
      }
      break;
    case 'edit':
      startEdit(all[idx]);
      break;
    case 'del': {
      const s = all[idx];
      if (confirm(`删除「${s.title || summarize(s.text)}」?`)) {
        const wasEditing = editingId === s.id;
        all.splice(idx, 1);
        await persist();
        if (wasEditing) resetForm(); // 正在编辑被删条目 → 退出编辑态
        else render();
        toast('已删除');
      }
      break;
    }
  }
});

$('#btn-save').addEventListener('click', async () => {
  const text = $('#f-text').value;
  if (!text.trim()) {
    toast('内容不能为空', true);
    $('#f-text').focus();
    return;
  }
  const title = $('#f-title').value.trim();
  const keywords = parseKeywords($('#f-keywords').value);
  if (editingId) {
    const s = all.find((x) => x.id === editingId);
    if (s) Object.assign(s, { title, text, keywords });
    toast('已保存');
  } else {
    all.unshift({ id: crypto.randomUUID(), title, text, keywords, createdAt: Date.now() });
    toast('已添加到列表顶部');
  }
  await persist();
  resetForm();
});

$('#btn-cancel').addEventListener('click', resetForm);

$('#btn-export').addEventListener('click', () => {
  if (!all.length) {
    toast('列表为空,没有可导出的内容', true);
    return;
  }
  downloadBackup(all, 'quick-text-backup');
  toast(`已导出 ${all.length} 条`);
});

$('#btn-import').addEventListener('click', () => $('#file').click());

$('#file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = ''; // 允许重复选同一文件
  if (!file) return;
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch (err) {
    toast('JSON 解析失败:' + err.message, true);
    return;
  }
  try {
    pendingImport = normalizeImported(parsed);
  } catch (err) {
    toast(err.message, true);
    return;
  }
  $('#import-count').textContent = `解析到 ${pendingImport.length} 条有效条目`;
  $('#import-bar').hidden = false;
});

$('#import-cancel').addEventListener('click', () => {
  pendingImport = null;
  $('#import-bar').hidden = true;
});

$('#import-ok').addEventListener('click', async () => {
  if (!pendingImport) return;
  const mode = document.querySelector('input[name="import-mode"]:checked').value;
  let msg;
  if (mode === 'replace') {
    if (all.length) downloadBackup(all, 'quick-text-auto-backup'); // 覆盖前自动备份
    if (!confirm(`覆盖模式:用导入的 ${pendingImport.length} 条替换现有 ${all.length} 条。` +
      (all.length ? '(当前数据已自动下载备份)' : '') + ' 继续?')) {
      return;
    }
    all = pendingImport;
    msg = `已覆盖为 ${all.length} 条`;
  } else {
    const existing = new Set(all.map((s) => s.text));
    let added = 0;
    for (const s of pendingImport) {
      if (!existing.has(s.text)) {
        all.push(s);
        existing.add(s.text);
        added++;
      }
    }
    msg = `合并完成:新增 ${added} 条,跳过重复 ${pendingImport.length - added} 条`;
  }
  await persist();
  pendingImport = null;
  $('#import-bar').hidden = true;
  render();
  toast(msg);
});

// ---------- 初始化 ----------
(async function init() {
  await loadSnippets();
  render();
})();
