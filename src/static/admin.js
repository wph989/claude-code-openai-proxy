// ── State ──
let currentConfig = { providers: [], models: [], default_client_model: null, proxy_auth_token: null };
let currentTab = 'providers';
let editingIndex = -1;        // -1 = add new
let providerPage = 1;
let modelPage = 1;
const PAGE_SIZE = 10;
let expandedKeyProvider = null; // provider_id of expanded key panel
let keyStates = {}; // { providerId: [ApiKeyEntry, ...] }

// sort state per tab
const sortState = {
  providers: { field: null, asc: true },
  models: { field: null, asc: true },
};

// ── DOM refs ──
const $ = (sel) => document.querySelector(sel);

const statusBox = $('#status');
const summaryWrap = $('#summary');
const preview = $('#jsonPreview');
const defaultClientModel = $('#defaultClientModel');
const proxyAuthTokenInput = $('#proxyAuthToken');
const keyMaxErrorsInput = $('#keyMaxErrors');
const tabProviders = $('#tab-providers');
const tabModels = $('#tab-models');
const tableContainer = $('#table-container');
const modalOverlay = $('#modal-overlay');
const modalTitle = $('#modal-title');
const modalBody = $('#modal-body');
const modalCancel = $('#modal-cancel');
const modalConfirm = $('#modal-confirm');

// ── Dialog 组件 ──
const Dialog = {
  overlay: null,
  container: null,

  init() {
    if (this.overlay) return;
    this.overlay = document.createElement('div');
    this.overlay.className = 'dialog-overlay';
    this.overlay.innerHTML = `
      <div class="dialog-container">
        <div class="dialog-header">
          <span class="dialog-title"></span>
          <button class="dialog-close" aria-label="关闭">×</button>
        </div>
        <div class="dialog-content"></div>
        <div class="dialog-footer"></div>
      </div>
    `;
    document.body.appendChild(this.overlay);
    this.container = this.overlay.querySelector('.dialog-container');

    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.hide();
    });
    this.overlay.querySelector('.dialog-close').addEventListener('click', () => this.hide());
  },

  show(title, content, buttons = []) {
    this.init();
    this.overlay.querySelector('.dialog-title').textContent = title;
    this.overlay.querySelector('.dialog-content').innerHTML = content;

    const footer = this.overlay.querySelector('.dialog-footer');
    footer.innerHTML = '';

    buttons.forEach(btn => {
      const button = document.createElement('button');
      button.className = `btn ${btn.class || ''}`;
      button.textContent = btn.text;
      button.addEventListener('click', () => {
        if (btn.action) btn.action();
        if (btn.close !== false) this.hide();
      });
      footer.appendChild(button);
    });

    this.overlay.classList.add('show');
  },

  hide() {
    if (this.overlay) this.overlay.classList.remove('show');
  },

  confirm(title, message, onConfirm, confirmText = '确认', cancelText = '取消', confirmClass = 'btn-primary') {
    this.show(title, `<p>${message}</p>`, [
      { text: cancelText, class: 'btn-secondary' },
      { text: confirmText, class: confirmClass, action: onConfirm }
    ]);
  },

  alert(title, message, onClose) {
    this.show(title, `<p>${message}</p>`, [
      { text: '确定', class: 'btn-primary', action: onClose }
    ]);
  }
};

// ── Helpers ──
function setStatus(text, isError) {
  statusBox.textContent = text;
  statusBox.className = 'status-bar ' + (isError ? 'error' : (text.includes('...') ? 'loading' : 'success'));
}

async function ensureSession() {
  const res = await fetch('/api/admin/session');
  const data = await res.json();
  if (!data.authenticated) { window.location.href = '/login'; throw new Error('未登录'); }
}

function parseJsonSafe(text, fallback) {
  try { return text.trim() ? JSON.parse(text) : fallback; }
  catch { throw new Error('JSON 字段格式不正确'); }
}

function strategyLabel(s) {
  return s === 'on_429' ? '遇429切换' : '轮询';
}

function maskKey(key) {
  if (!key || key.length <= 10) return '••••••••';
  return key.slice(0, 5) + '••••' + key.slice(-5);
}

function getKeyArray(provider) {
  const ak = provider.api_key;
  if (!ak) return [];
  if (typeof ak === 'string') {
    return ak.split(',').map(k => k.trim()).filter(Boolean).map(k => ({
      key: k, enabled: true, error_count: 0, disabled_at: null,
      last_error_at: null, last_error_message: null, auto_disabled_at: null
    }));
  }
  if (Array.isArray(ak)) return ak;
  return [];
}

function countKeyStats(keys) {
  let enabled = 0, disabled = 0, totalErrors = 0;
  for (const k of keys) {
    if (k.enabled) enabled++; else disabled++;
    totalErrors += (k.error_count || 0);
  }
  return { enabled, disabled, totalErrors };
}

function formatTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ── API ──
async function loadConfig() {
  setStatus('正在加载配置...');
  const res = await fetch('/api/config', { credentials: 'include' });
  if (res.status === 401) { window.location.href = '/login'; return; }
  const data = await res.json();
  currentConfig = data.config;
  renderSummary(data.summary);
  proxyAuthTokenInput.value = currentConfig.proxy_auth_token || '';
  keyMaxErrorsInput.value = currentConfig.key_max_errors || '';
  refreshDefaultModelSelect();
  renderTable();
  updatePreviewNow();
  setStatus('配置已加载');
}

function buildPayload() {
  const keyMaxErrorsVal = parseInt(keyMaxErrorsInput.value, 10);
  return {
    ...currentConfig,
    default_client_model: defaultClientModel.value || null,
    proxy_auth_token: proxyAuthTokenInput.value.trim() || null,
    key_max_errors: Number.isFinite(keyMaxErrorsVal) && keyMaxErrorsVal > 0 ? keyMaxErrorsVal : null,
  };
}

async function saveConfig() {
  try {
    setStatus('正在保存配置...');
    const payload = buildPayload();
    const res = await fetch('/api/config', {
      method: 'PUT', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || data?.message || '保存失败');
    currentConfig = data.config;
    renderSummary(data.summary);
    refreshDefaultModelSelect();
    renderTable();
    updatePreviewNow();
    setStatus(data.message || '保存成功');
  } catch (error) {
    setStatus('保存失败：' + error.message, true);
  }
}

async function loadKeyStates(providerId) {
  try {
    const res = await fetch(`/api/keys/${encodeURIComponent(providerId)}`, { credentials: 'include' });
    if (!res.ok) return [];
    const data = await res.json();
    keyStates[providerId] = data.keys || [];
    return data.keys || [];
  } catch {
    return [];
  }
}

async function keyAction(providerId, keyIndex, action) {
  try {
    const res = await fetch(`/api/keys/${encodeURIComponent(providerId)}/${keyIndex}/${action}`, {
      method: 'PUT', credentials: 'include',
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.message || '操作失败');
    setStatus(data.message || '操作成功');
    await loadKeyStates(providerId);
    await loadConfig();
    renderKeyPanel(providerId);
  } catch (err) {
    setStatus('操作失败：' + err.message, true);
  }
}

// ── Render ──
function renderSummary(summary) {
  const items = [
    ['供应商总数', summary.provider_count || 0],
    ['模型总数', summary.model_count || 0],
    ['启用供应商', summary.enabled_provider_count || 0],
    ['启用模型', summary.enabled_model_count || 0],
  ];
  summaryWrap.innerHTML = items.map(([k,v],i) =>
    `<div class="stat-card" style="animation-delay:${i*50}ms"><div class="stat-label">${k}</div><div class="stat-value">${v}</div></div>`
  ).join('');
}

function refreshDefaultModelSelect() {
  const ids = currentConfig.models.filter(m => m.enabled !== false).map(m => m.client_model).filter(Boolean);
  const old = defaultClientModel.value;
  defaultClientModel.innerHTML = '<option value="">未设置</option>' + ids.map(id => `<option value="${id}">${id}</option>`).join('');
  defaultClientModel.value = ids.includes(old) ? old : (currentConfig.default_client_model || '');
}

let updatePreviewTimer = null;
function updatePreview() {
  clearTimeout(updatePreviewTimer);
  updatePreviewTimer = setTimeout(() => {
    preview.textContent = JSON.stringify(buildPayload(), null, 2);
  }, 300);
}

function updatePreviewNow() {
  clearTimeout(updatePreviewTimer);
  preview.textContent = JSON.stringify(buildPayload(), null, 2);
}

// ── Sorting ──
function sortItems(items, field, asc) {
  if (!field) return [...items];
  return [...items].sort((a, b) => {
    let va = a[field], vb = b[field];
    if (typeof va === 'boolean') { va = va ? 1 : 0; vb = vb ? 1 : 0; }
    if (va == null) va = '';
    if (vb == null) vb = '';
    const sa = String(va).toLowerCase();
    const sb = String(vb).toLowerCase();
    if (sa < sb) return asc ? -1 : 1;
    if (sa > sb) return asc ? 1 : -1;
    return 0;
  });
}

function setSort(tab, field) {
  const st = sortState[tab];
  if (st.field === field) {
    if (st.asc) { st.asc = false; }
    else { st.field = null; st.asc = true; }
  } else {
    st.field = field; st.asc = true;
  }
  if (tab === 'providers') providerPage = 1;
  else modelPage = 1;
  renderTable();
}

// ── Table ──
function renderTable() {
  const isProvider = currentTab === 'providers';
  const items = isProvider ? currentConfig.providers : currentConfig.models;
  const st = sortState[currentTab];
  const sorted = sortItems(items, st.field, st.asc);
  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const page = isProvider ? providerPage : modelPage;
  const clampedPage = Math.max(1, Math.min(page, totalPages));
  const start = (clampedPage - 1) * PAGE_SIZE;
  const pageItems = sorted.slice(start, start + PAGE_SIZE);

  if (isProvider) providerPage = clampedPage;
  else modelPage = clampedPage;

  const originalIdx = new Map();
  items.forEach((item, i) => originalIdx.set(item, i));
  const idxMap = new Map();
  for (let i = 0; i < sorted.length; i++) {
    idxMap.set(sorted[i], originalIdx.get(sorted[i]));
  }

  const providerIds = currentConfig.providers.map(p => p.provider_id).filter(Boolean);

  let html = '<div class="card">';
  html += '<div class="table-toolbar">';
  html += `<span class="section-subtitle" style="margin:0">${isProvider ? '供应商列表' : '模型映射列表'}（共 ${sorted.length} 条）</span>`;
  html += `<button class="btn btn-primary btn-small" id="addBtn">+ 新增${isProvider ? '供应商' : '模型映射'}</button>`;
  html += '</div>';

  if (sorted.length === 0) {
    html += '<div class="empty-state"><p>暂无数据</p></div>';
  } else {
    html += '<table class="data-table">';
    if (isProvider) {
      html += renderTableHead(['provider_id','provider_type','base_url','key_rotation_strategy','enabled'], st, ['ID','类型','URL','切换策略','状态']);
    } else {
      html += renderTableHead(['client_model','provider_id','upstream_model','enabled'], st, ['客户端模型','供应商','上游模型','状态']);
    }
    html += '<tbody>';
    for (let i = 0; i < pageItems.length; i++) {
      const item = pageItems[i];
      const realIdx = idxMap.get(item);
      if (isProvider) {
        html += renderProviderRow(item, realIdx);
        if (expandedKeyProvider === item.provider_id) {
          html += renderKeyPanelHtml(item.provider_id);
        }
      } else {
        html += renderModelRow(item, realIdx, providerIds);
      }
    }
    html += '</tbody></table>';
  }

  html += renderPagination(clampedPage, totalPages, sorted.length);
  html += '</div>';
  tableContainer.innerHTML = html;
}

function renderTableHead(fields, st, labels) {
  let h = '<thead><tr>';
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    const sorted = st.field === f ? ' sorted' : '';
    const arrow = st.field === f ? (st.asc ? ' ▲' : ' ▼') : ' ⇅';
    h += `<th data-field="${f}" class="${sorted}">${labels[i]}<span class="sort-arrow">${arrow}</span></th>`;
  }
  h += '<th class="col-actions">操作</th></tr></thead>';
  return h;
}

function renderProviderRow(p, idx) {
  const strat = strategyLabel(p.key_rotation_strategy);
  const typeLabel = p.provider_type === 'anthropic' ? 'Anthropic' : 'OpenAI';
  const badge = p.enabled !== false
    ? `<span class="badge badge-on toggle-enabled" data-idx="${idx}" data-type="provider" title="点击停用">启用</span>`
    : `<span class="badge badge-off toggle-enabled" data-idx="${idx}" data-type="provider" title="点击启用">停用</span>`;
  const keys = getKeyArray(p);
  const stats = countKeyStats(keys);
  const keySummary = keys.length > 0
    ? `<span class="key-summary">${stats.enabled}/${keys.length} 可用</span>${stats.disabled > 0 ? `<span class="badge badge-off" style="margin-left:6px">${stats.disabled} 禁用</span>` : ''}`
    : '<span class="text-dim">无 Key</span>';
  const isExpanded = expandedKeyProvider === p.provider_id;
  return `<tr>
    <td class="col-id">${esc(p.provider_id)}</td>
    <td>${typeLabel}</td>
    <td class="col-url" title="${esc(p.base_url)}">${esc(p.base_url)}</td>
    <td class="col-strategy">${strat}</td>
    <td>${badge}</td>
    <td class="col-actions">
      <button class="btn-icon keys-btn" data-provider="${esc(p.provider_id)}" title="管理 API Keys">${isExpanded ? '收起 Keys' : 'Keys'} (${keys.length})</button>
      <button class="btn-icon move-up-btn" data-idx="${idx}">上移</button>
      <button class="btn-icon move-down-btn" data-idx="${idx}">下移</button>
      <button class="btn-icon edit-btn" data-idx="${idx}">编辑</button>
      <button class="btn-icon danger delete-btn" data-idx="${idx}">删除</button>
    </td>
  </tr>`;
}

function renderKeyPanelHtml(providerId) {
  const keys = keyStates[providerId] || getKeyArray(currentConfig.providers.find(p => p.provider_id === providerId) || {});

  let rows = '';
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const enabledBadge = k.enabled
      ? `<span class="badge badge-on toggle-enabled" data-type="key" data-provider="${esc(providerId)}" data-idx="${i}" title="点击禁用">启用</span>`
      : (k.auto_disabled_at
        ? `<span class="badge badge-auto-off toggle-enabled" data-type="key" data-provider="${esc(providerId)}" data-idx="${i}" title="点击启用">自动禁用</span>`
        : `<span class="badge badge-off toggle-enabled" data-type="key" data-provider="${esc(providerId)}" data-idx="${i}" title="点击启用">手动禁用</span>`);

    const errorBadge = k.error_count > 0
      ? `<span class="badge ${k.error_count >= 3 ? 'badge-warn' : 'badge-info'}">错误 ${k.error_count} 次</span>`
      : '<span class="text-dim">无错误</span>';

    let actions = `<button class="btn-icon key-action-btn" data-provider="${esc(providerId)}" data-idx="${i}" data-action="reset">重置</button>`;
    actions += `<button class="btn-icon danger key-delete-btn" data-provider="${esc(providerId)}" data-idx="${i}">删除</button>`;

    const lastError = k.last_error_message
      ? `<span class="key-error-detail" title="${esc(k.last_error_message)}">${esc(k.last_error_message)} · ${formatTime(k.last_error_at)}</span>`
      : '';

    const noteStr = k.note ? `<span class="key-note" title="${esc(k.note)}">${esc(k.note)}</span>` : '';

    rows += `<tr class="key-detail-row">
      <td class="key-col-index">${i + 1}</td>
      <td class="key-col-key" title="${esc(k.key)}">${maskKey(k.key)} ${noteStr}</td>
      <td class="key-col-note">
        <input class="key-note-input" data-provider="${esc(providerId)}" data-idx="${i}" value="${esc(k.note || '')}" placeholder="备注..." />
      </td>
      <td class="key-col-status">${enabledBadge}</td>
      <td class="key-col-errors">${errorBadge}${lastError ? '<br>' + lastError : ''}</td>
      <td class="key-col-time">${k.auto_disabled_at ? formatTime(k.auto_disabled_at) : (k.disabled_at ? formatTime(k.disabled_at) : '-')}</td>
      <td class="key-col-actions">${actions}</td>
    </tr>`;
  }

  return `<tr class="key-panel-row"><td colspan="6">
    <div class="key-panel">
      <div class="key-panel-header">
        <h3>API Keys — ${esc(providerId)}</h3>
        <button class="btn btn-small key-export-btn" data-provider="${esc(providerId)}">导出所有 Key</button>
        <button class="btn btn-small key-reset-all-btn" data-provider="${esc(providerId)}">一键重置所有 Key</button>
        <button class="btn btn-small key-refresh-btn" data-provider="${esc(providerId)}">刷新</button>
      </div>
      <div class="key-add-panel" style="margin-bottom:16px;">
        <textarea class="key-add-input" data-provider="${esc(providerId)}" rows="2" placeholder="输入新 Key，支持多个（逗号或换行分隔）" style="width:100%;margin-bottom:8px;"></textarea>
        <button class="btn btn-small key-add-btn" data-provider="${esc(providerId)}">添加 Key</button>
      </div>
      ${keys.length === 0 ? '<div class="key-panel-empty">暂无 API Key，请在上方输入框添加。</div>' : `
      <table class="key-detail-table">
        <thead><tr>
          <th style="width:40px">#</th>
          <th>Key</th>
          <th style="width:140px">备注</th>
          <th style="width:120px">状态</th>
          <th style="width:180px">错误</th>
          <th style="width:140px">禁用时间</th>
          <th style="width:160px" class="col-actions">操作</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`}
    </div>
  </td></tr>`;
}

function renderModelRow(m, idx, providerIds) {
  const badge = m.enabled !== false
    ? `<span class="badge badge-on toggle-enabled" data-idx="${idx}" data-type="model" title="点击停用">启用</span>`
    : `<span class="badge badge-off toggle-enabled" data-idx="${idx}" data-type="model" title="点击启用">停用</span>`;
  return `<tr>
    <td class="col-model">${esc(m.client_model)}</td>
    <td>${esc(m.provider_id)}</td>
    <td>${esc(m.upstream_model)}</td>
    <td>${badge}</td>
    <td class="col-actions">
      <button class="btn-icon move-up-btn" data-idx="${idx}">上移</button>
      <button class="btn-icon move-down-btn" data-idx="${idx}">下移</button>
      <button class="btn-icon edit-btn" data-idx="${idx}">编辑</button>
      <button class="btn-icon danger delete-btn" data-idx="${idx}">删除</button>
    </td>
  </tr>`;
}

function renderPagination(page, total, totalItems) {
  if (total <= 1) return '';
  return `<div class="pagination">
    <span class="pagination-info">共 ${totalItems} 条，第 ${page}/${total} 页</span>
    <div class="pagination-btns">
      <button class="btn btn-small" id="prevPage" ${page <= 1 ? 'disabled' : ''}>上一页</button>
      <span class="page-num">${page} / ${total}</span>
      <button class="btn btn-small" id="nextPage" ${page >= total ? 'disabled' : ''}>下一页</button>
    </div>
  </div>`;
}

function changePage(dir) {
  if (currentTab === 'providers') {
    const total = Math.max(1, Math.ceil(currentConfig.providers.length / PAGE_SIZE));
    providerPage = Math.max(1, Math.min(total, providerPage + dir));
  } else {
    const total = Math.max(1, Math.ceil(currentConfig.models.length / PAGE_SIZE));
    modelPage = Math.max(1, Math.min(total, modelPage + dir));
  }
  renderTable();
}

function moveItem(idx, dir) {
  const arr = currentTab === 'providers' ? currentConfig.providers : currentConfig.models;
  const newIdx = idx + dir;
  if (newIdx < 0 || newIdx >= arr.length) return;
  [arr[idx], arr[newIdx]] = [arr[newIdx], arr[idx]];
  renderTable();
  updatePreviewNow();
}

async function toggleKeyPanel(providerId) {
  if (expandedKeyProvider === providerId) {
    expandedKeyProvider = null;
    renderTable();
    return;
  }
  expandedKeyProvider = providerId;
  await loadKeyStates(providerId);
  renderTable();
}

async function renderKeyPanel(providerId) {
  await loadKeyStates(providerId);
  renderTable();
}

function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

tableContainer.addEventListener('change', (e) => {
  const input = e.target;
  if (input.classList.contains('key-note-input')) {
    const providerId = input.dataset.provider;
    const keyIndex = parseInt(input.dataset.idx, 10);
    const note = input.value.trim();
    fetch(`/api/keys/${encodeURIComponent(providerId)}/${keyIndex}/note`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note })
    })
    .then(res => res.json().then(data => ({ ok: res.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.message || '更新失败');
      renderKeyPanel(providerId);
      loadConfig();
    })
    .catch(err => Dialog.alert('错误', '备注更新失败：' + err.message));
    return;
  }
});
tableContainer.addEventListener('click', (e) => {
  // handle toggle-enabled clicks on span/button
  const toggleTarget = e.target.closest('.toggle-enabled');
  if (toggleTarget) {
    const type = toggleTarget.dataset.type;
    const idx = parseInt(toggleTarget.dataset.idx);
    if (type === 'provider' || type === 'model') {
      const arr = type === 'provider' ? currentConfig.providers : currentConfig.models;
      if (idx >= 0 && idx < arr.length) {
        arr[idx].enabled = arr[idx].enabled === false ? true : false;
        renderTable();
        updatePreviewNow();
      }
    } else if (type === 'key') {
      const providerId = toggleTarget.dataset.provider;
      const keyIndex = parseInt(toggleTarget.dataset.idx);
      const keys = keyStates[providerId];
      if (keys && keys[keyIndex]) {
        const action = keys[keyIndex].enabled ? 'disable' : 'enable';
        keyAction(providerId, keyIndex, action);
      }
    }
    return;
  }

  const target = e.target.closest('button');
  if (!target) return;

  const isProvider = currentTab === 'providers';

  if (target.id === 'addBtn') {
    openModal(currentTab, -1);
    return;
  }

  if (target.id === 'prevPage') {
    changePage(-1);
    return;
  }

  if (target.id === 'nextPage') {
    changePage(1);
    return;
  }

  if (target.classList.contains('keys-btn')) {
    toggleKeyPanel(target.dataset.provider);
    return;
  }

  if (target.classList.contains('key-refresh-btn')) {
    renderKeyPanel(target.dataset.provider);
    return;
  }

  if (target.classList.contains('key-export-btn')) {
    const providerId = target.dataset.provider;
    window.open(`/api/keys/${encodeURIComponent(providerId)}/export`, '_blank');
    return;
  }

  if (target.classList.contains('key-add-btn')) {
    const providerId = target.dataset.provider;
    const input = tableContainer.querySelector(`.key-add-input[data-provider="${providerId}"]`);
    const raw = input?.value || '';
    const keys = raw.split(/[,，\n]+/).map(k => k.trim()).filter(Boolean);
    if (keys.length === 0) {
      Dialog.alert('提示', '请输入至少一个 Key 值');
      return;
    }
    fetch(`/api/keys/${encodeURIComponent(providerId)}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys })
    })
    .then(res => res.json().then(data => ({ ok: res.ok, data })))
    .then(({ ok, data }) => {
      if (!ok) throw new Error(data.message || data.error || '添加失败');
      setStatus(data.message || `${keys.length} 个 Key 已添加到 ${providerId}`);
      input.value = '';
      renderKeyPanel(providerId);
      loadConfig();
    })
    .catch(err => Dialog.alert('错误', '添加失败：' + err.message));
    return;
  }

  if (target.classList.contains('key-reset-all-btn')) {
    const providerId = target.dataset.provider;
    Dialog.confirm('确认重置', `确定要重置 ${providerId} 的所有 Key 错误计数并重新启用吗？`, () => {
      fetch(`/api/keys/${encodeURIComponent(providerId)}/reset-all`, {
        method: 'PUT',
        credentials: 'include'
      })
      .then(res => res.json().then(data => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (!ok) throw new Error(data.message || '重置失败');
        setStatus(data.message || `${providerId} 所有 Key 已重置`);
        renderKeyPanel(providerId);
        loadConfig();
      })
      .catch(err => Dialog.alert('错误', '重置失败：' + err.message));
    }, '确认重置', '取消', 'btn-warning');
    return;
  }

  if (target.classList.contains('key-delete-btn')) {
    const providerId = target.dataset.provider;
    const keyIndex = parseInt(target.dataset.idx);
    Dialog.confirm('确认删除', `确定要删除 ${providerId} 的第 ${keyIndex + 1} 个 Key 吗？`, () => {
      fetch(`/api/keys/${encodeURIComponent(providerId)}/${keyIndex}`, {
        method: 'DELETE',
        credentials: 'include'
      })
      .then(res => res.json().then(data => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (!ok) throw new Error(data.error || '删除失败');
        setStatus(`Key 已从 ${providerId} 删除`);
        renderKeyPanel(providerId);
        loadConfig();
      })
      .catch(err => Dialog.alert('错误', '删除失败：' + err.message));
    }, '确认删除', '取消', 'btn-danger');
    return;
  }

  if (target.classList.contains('key-action-btn')) {
    const providerId = target.dataset.provider;
    const keyIndex = parseInt(target.dataset.idx);
    const action = target.dataset.action;
    if (action === 'reset') {
      Dialog.confirm('确认重置', `确定要重置该 Key 的错误计数并重新启用吗？`, () => {
        keyAction(providerId, keyIndex, action);
      });
    } else {
      keyAction(providerId, keyIndex, action);
    }
    return;
  }

  if (target.classList.contains('edit-btn')) {
    openModal(currentTab, parseInt(target.dataset.idx));
    return;
  }

  if (target.classList.contains('move-up-btn')) {
    moveItem(parseInt(target.dataset.idx), -1);
    return;
  }

  if (target.classList.contains('move-down-btn')) {
    moveItem(parseInt(target.dataset.idx), 1);
    return;
  }

  if (target.classList.contains('delete-btn')) {
    const idx = parseInt(target.dataset.idx);
    const itemName = isProvider ? currentConfig.providers[idx]?.provider_id : currentConfig.models[idx]?.client_model;
    Dialog.confirm('确认删除', `确定要删除 "${itemName || '此项目'}" 吗？此操作不可撤销。`, () => {
      if (isProvider) {
        currentConfig.providers.splice(idx, 1);
      } else {
        currentConfig.models.splice(idx, 1);
      }
      refreshDefaultModelSelect();
      renderTable();
      updatePreviewNow();
    }, '确认删除', '取消', 'btn-danger');
    return;
  }
});

tableContainer.addEventListener('click', (e) => {
  const th = e.target.closest('.data-table th');
  if (th && th.dataset.field) {
    setSort(currentTab, th.dataset.field);
  }
});

// ── Modal ──
function openModal(tab, idx) {
  editingIndex = idx;
  const isProvider = tab === 'providers';
  const isEdit = idx >= 0;
  const item = isEdit ? (isProvider ? currentConfig.providers[idx] : currentConfig.models[idx]) : null;

  modalTitle.textContent = (isEdit ? '编辑' : '新增') + (isProvider ? '供应商' : '模型映射');

  if (isProvider) {
    modalBody.innerHTML = providerFormHtml(item);
  } else {
    modalBody.innerHTML = modelFormHtml(item);
  }
  modalOverlay.classList.add('open');
}

function closeModal() {
  modalOverlay.classList.remove('open');
  editingIndex = -1;
}

function submitModal() {
  const isProvider = currentTab === 'providers';
  try {
    const item = isProvider ? collectProviderForm() : collectModelForm();
    if (editingIndex >= 0) {
      if (isProvider) {
        const existing = currentConfig.providers[editingIndex];
        const existingKeys = getKeyArray(existing);
        const newKeys = item.api_key;
        if (Array.isArray(newKeys) && newKeys.length > 0) {
          const existingKeyValues = new Set(existingKeys.map(k => k.key));
          const toAppend = newKeys.filter(k => !existingKeyValues.has(k.key));
          item.api_key = [...existingKeys, ...toAppend];
          if (toAppend.length > 0) {
            setStatus(`新增 ${toAppend.length} 个 Key，保留原有 ${existingKeys.length} 个`);
          } else if (newKeys.length > 0) {
            setStatus('输入的 Key 已存在，未做更改');
          }
        } else {
          item.api_key = existingKeys.length > 0 ? existingKeys : null;
        }
        currentConfig.providers[editingIndex] = item;
      }
      else currentConfig.models[editingIndex] = item;
    } else {
      if (isProvider) {
        currentConfig.providers.push(item);
        const newKeys = item.api_key;
        if (Array.isArray(newKeys) && newKeys.length > 0) {
          setStatus(`新增供应商，包含 ${newKeys.length} 个 Key`);
        }
      }
      else currentConfig.models.push(item);
    }
    closeModal();
    refreshDefaultModelSelect();
    renderTable();
    updatePreviewNow();
  } catch (e) {
    Dialog.alert('错误', e.message);
  }
}

function providerFormHtml(item) {
  const p = item || {};
  const keys = getKeyArray(p);
  const keyDisplay = keys.length > 0
    ? `<div class="key-info-box"><span class="form-label">当前 API Keys</span><div class="key-list-preview">${keys.map((k, i) =>
        `<div class="key-list-item ${k.enabled ? '' : 'key-disabled'}">${i + 1}. ${maskKey(k.key)} <span class="badge ${k.enabled ? 'badge-on' : 'badge-off'}">${k.enabled ? '启用' : '禁用'}</span> <span class="text-dim">错误: ${k.error_count || 0}</span></div>`
      ).join('')}</div><p class="form-hint">在供应商列表的"Keys"面板中管理各 Key 的启用/禁用/重置。新增 Key 请在下方输入。</p></div>`
    : '';

  return `
    <div class="form-grid">
      <div class="form-group">
        <span class="form-label">provider_id *</span>
        <input id="mf-provider_id" type="text" value="${esc(p.provider_id)}" placeholder="例如：nvidia2" />
      </div>
      <div class="form-group">
        <span class="form-label">说明</span>
        <input id="mf-description" type="text" value="${esc(p.description)}" placeholder="例如：第二个 NVIDIA 入口" />
      </div>
      <div class="form-group">
        <span class="form-label">供应商类型 *</span>
        <select id="mf-provider_type">
          <option value="openai_compatible" ${(p.provider_type||'openai_compatible')==='openai_compatible'?'selected':''}>OpenAI Compatible（协议转换/透传）</option>
          <option value="anthropic" ${p.provider_type==='anthropic'?'selected':''}>Anthropic Compatible（透传）</option>
        </select>
      </div>
      <div class="form-group">
        <span class="form-label">base_url *</span>
        <input id="mf-base_url" type="text" value="${esc(p.base_url)}" placeholder="https://integrate.api.nvidia.com/v1" />
      </div>
      <div class="form-group">
        <span class="form-label">api_key_env</span>
        <input id="mf-api_key_env" type="text" value="${esc(p.api_key_env)}" placeholder="多个环境变量名用逗号分隔" />
      </div>
      <div class="form-group">
        <span class="form-label">新增 api_key（多个 key 用逗号分隔）</span>
        <input id="mf-api_key" type="password" value="" placeholder="留空则保留现有 Key 不变" />
      </div>
      <div class="form-group">
        <span class="form-label">API Key 切换策略</span>
        <select id="mf-key_rotation_strategy">
          <option value="round_robin" ${(p.key_rotation_strategy||'round_robin')==='round_robin'?'selected':''}>轮询 (Round-Robin)</option>
          <option value="on_429" ${p.key_rotation_strategy==='on_429'?'selected':''}>遇 429 自动切换</option>
        </select>
      </div>
      <div class="form-group">
        <label class="checkbox-wrapper">
          <input id="mf-auto_disable_on_error" type="checkbox" ${p.auto_disable_on_error!==false?'checked':''} />
          <span class="checkbox-label">错误累计自动禁用 Key（部分不稳定供应商可关闭此功能，调用成功后错误计数自动清零）</span>
        </label>
      </div>
      <div class="form-group">
        <span class="form-label">timeout_seconds</span>
        <input id="mf-timeout_seconds" type="number" min="1" value="${p.timeout_seconds||300}" />
      </div>
      <div class="form-group">
        <span class="form-label">stream_idle_timeout_seconds</span>
        <input id="mf-stream_idle_timeout_seconds" type="number" min="1" value="${p.stream_idle_timeout_seconds||120}" />
      </div>
    </div>
    ${keyDisplay}
    <div class="form-group">
      <label class="checkbox-wrapper">
        <input id="mf-enabled" type="checkbox" ${p.enabled!==false?'checked':''} />
        <span class="checkbox-label">启用该供应商</span>
      </label>
    </div>
    <div class="form-group">
      <span class="form-label">headers（JSON 对象，可选）</span>
      <textarea id="mf-headers" placeholder='{"api-version":"2024-xx"}'>${JSON.stringify(p.headers||{},null,2)}</textarea>
    </div>`;
}

function modelFormHtml(item) {
  const m = item || {};
  const providerOpts = currentConfig.providers.map(p =>
    `<option value="${esc(p.provider_id)}" ${m.provider_id===p.provider_id?'selected':''}>${esc(p.provider_id)}</option>`
  ).join('');
  return `
    <div class="form-grid">
      <div class="form-group">
        <span class="form-label">客户端模型名 *</span>
        <input id="mf-client_model" type="text" value="${esc(m.client_model)}" placeholder="例如：claude-sonnet-4-5" />
      </div>
      <div class="form-group">
        <span class="form-label">绑定供应商 *</span>
        <select id="mf-provider_id">
          <option value="">请选择供应商</option>
          ${providerOpts}
        </select>
      </div>
      <div class="form-group">
        <span class="form-label">上游模型名 *</span>
        <input id="mf-upstream_model" type="text" value="${esc(m.upstream_model)}" placeholder="例如：meta/llama-3.1-70b-instruct" />
      </div>
      <div class="form-group">
        <span class="form-label">说明</span>
        <input id="mf-description" type="text" value="${esc(m.description)}" placeholder="例如：给 Claude Code 使用的映射" />
      </div>
    </div>
    <div class="form-group">
      <label class="checkbox-wrapper">
        <input id="mf-enabled" type="checkbox" ${m.enabled!==false?'checked':''} />
        <span class="checkbox-label">启用该模型映射</span>
      </label>
    </div>
    <div class="form-group">
      <span class="form-label">extra_body（JSON 对象，可选）</span>
      <textarea id="mf-extra_body" placeholder='{"top_k":20}'>${JSON.stringify(m.extra_body||{},null,2)}</textarea>
    </div>`;
}

function collectProviderForm() {
  const provider_id = $('#mf-provider_id').value.trim();
  const base_url = $('#mf-base_url').value.trim();
  if (!provider_id) throw new Error('provider_id 不能为空');
  if (!base_url) throw new Error('base_url 不能为空');

  const newKeyInput = $('#mf-api_key').value.trim();
  let apiKey = null;
  if (newKeyInput) {
    apiKey = newKeyInput.split(',').map(k => k.trim()).filter(Boolean).map(k => ({
      key: k, enabled: true, error_count: 0, disabled_at: null,
      last_error_at: null, last_error_message: null, auto_disabled_at: null
    }));
    if (apiKey.length === 0) apiKey = null;
  }

  return {
    provider_id,
    provider_type: $('#mf-provider_type').value || 'openai_compatible',
    base_url,
    api_key: apiKey,
    api_key_env: $('#mf-api_key_env').value.trim() || null,
    key_rotation_strategy: $('#mf-key_rotation_strategy').value || 'round_robin',
    timeout_seconds: Number($('#mf-timeout_seconds').value || 300),
    stream_idle_timeout_seconds: Number($('#mf-stream_idle_timeout_seconds').value || 120),
    enabled: $('#mf-enabled').checked,
    auto_disable_on_error: $('#mf-auto_disable_on_error').checked,
    headers: parseJsonSafe($('#mf-headers').value, {}),
    description: $('#mf-description').value.trim(),
  };
}

function collectModelForm() {
  const client_model = $('#mf-client_model').value.trim();
  const provider_id = $('#mf-provider_id').value.trim();
  const upstream_model = $('#mf-upstream_model').value.trim();
  if (!client_model) throw new Error('client_model 不能为空');
  if (!provider_id) throw new Error('provider_id 不能为空');
  if (!upstream_model) throw new Error('upstream_model 不能为空');
  return {
    client_model,
    provider_id,
    upstream_model,
    enabled: $('#mf-enabled').checked,
    extra_body: parseJsonSafe($('#mf-extra_body').value, {}),
    description: $('#mf-description').value.trim(),
  };
}

// ── Tab switching ──
function switchTab(tab) {
  currentTab = tab;
  expandedKeyProvider = null;
  tabProviders.classList.toggle('active', tab === 'providers');
  tabModels.classList.toggle('active', tab === 'models');
  renderTable();
}

// ── Events ──
tabProviders.addEventListener('click', () => switchTab('providers'));
tabModels.addEventListener('click', () => switchTab('models'));
modalCancel.addEventListener('click', closeModal);
$('#modal-cancel-btn').addEventListener('click', closeModal);
modalConfirm.addEventListener('click', submitModal);
modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
$('#refreshBtn').addEventListener('click', loadConfig);
$('#saveBtn').addEventListener('click', saveConfig);
$('#logoutBtn').addEventListener('click', async () => {
  await fetch('/api/admin/logout', { method: 'POST', credentials: 'include' });
  window.location.href = '/login';
});
defaultClientModel.addEventListener('change', updatePreview);
proxyAuthTokenInput.addEventListener('input', updatePreview);
keyMaxErrorsInput.addEventListener('input', updatePreview);

// ── Init ──
ensureSession().then(loadConfig).catch(e => setStatus(e.message, true));
