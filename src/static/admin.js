// ── State ──
let currentConfig = { providers: [], models: [], default_client_model: null, proxy_auth_token: null };
let currentTab = 'providers';
let editingIndex = -1;        // -1 = add new
let providerPage = 1;
let modelPage = 1;
const PAGE_SIZE = 10;

// sort state per tab
const sortState = {
  providers: { field: 'provider_id', asc: true },
  models: { field: 'client_model', asc: true },
};

// ── DOM refs ──
const $ = (sel) => document.querySelector(sel);

const statusBox = $('#status');
const summaryWrap = $('#summary');
const preview = $('#jsonPreview');
const defaultClientModel = $('#defaultClientModel');
const proxyAuthTokenInput = $('#proxyAuthToken');
const tabProviders = $('#tab-providers');
const tabModels = $('#tab-models');
const tableContainer = $('#table-container');
const modalOverlay = $('#modal-overlay');
const modalTitle = $('#modal-title');
const modalBody = $('#modal-body');
const modalCancel = $('#modal-cancel');
const modalConfirm = $('#modal-confirm');

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

// ── API ──
async function loadConfig() {
  setStatus('正在加载配置...');
  const res = await fetch('/api/config', { credentials: 'include' });
  if (res.status === 401) { window.location.href = '/login'; return; }
  const data = await res.json();
  currentConfig = data.config;
  renderSummary(data.summary);
  proxyAuthTokenInput.value = currentConfig.proxy_auth_token || '';
  refreshDefaultModelSelect();
  renderTable();
  updatePreviewNow();
  setStatus('配置已加载');
}

async function saveConfig() {
  try {
    setStatus('正在保存配置...');
    const payload = {
      ...currentConfig,
      default_client_model: defaultClientModel.value || null,
      proxy_auth_token: proxyAuthTokenInput.value.trim() || null,
    };
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
    const payload = {
      ...currentConfig,
      default_client_model: defaultClientModel.value || null,
      proxy_auth_token: proxyAuthTokenInput.value.trim() || null,
    };
    preview.textContent = JSON.stringify(payload, null, 2);
  }, 300);
}

function updatePreviewNow() {
  clearTimeout(updatePreviewTimer);
  const payload = {
    ...currentConfig,
    default_client_model: defaultClientModel.value || null,
    proxy_auth_token: proxyAuthTokenInput.value.trim() || null,
  };
  preview.textContent = JSON.stringify(payload, null, 2);
}

// ── Sorting ──
function sortItems(items, field, asc) {
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
  if (st.field === field) { st.asc = !st.asc; }
  else { st.field = field; st.asc = true; }
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

  const idxMap = new Map();
  for (let i = 0; i < sorted.length; i++) {
    idxMap.set(sorted[i], i);
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
      html += renderTableHead(['provider_id','base_url','key_rotation_strategy','enabled'], st, ['ID','URL','切换策略','状态']);
    } else {
      html += renderTableHead(['client_model','provider_id','upstream_model','enabled'], st, ['客户端模型','供应商','上游模型','状态']);
    }
    html += '<tbody>';
    for (let i = 0; i < pageItems.length; i++) {
      const item = pageItems[i];
      const realIdx = idxMap.get(item);
      if (isProvider) {
        html += renderProviderRow(item, realIdx);
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

// ── Event delegation for dynamic table content
tableContainer.addEventListener('click', (e) => {
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

  if (target.classList.contains('edit-btn')) {
    openModal(currentTab, parseInt(target.dataset.idx));
    return;
  }

  if (target.classList.contains('delete-btn')) {
    if (!confirm('确定删除？此操作不可撤销。')) return;
    const idx = parseInt(target.dataset.idx);
    if (isProvider) {
      currentConfig.providers.splice(idx, 1);
    } else {
      currentConfig.models.splice(idx, 1);
    }
    refreshDefaultModelSelect();
    renderTable();
    updatePreviewNow();
    return;
  }
});

tableContainer.addEventListener('click', (e) => {
  const th = e.target.closest('.data-table th');
  if (th && th.dataset.field) {
    setSort(currentTab, th.dataset.field);
  }
});

function renderTableHead(fields, st, labels) {
  let h = '<thead><tr>';
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    const sorted = st.field === f ? ' sorted' : '';
    const arrow = st.field === f ? (st.asc ? ' ▲' : ' ▼') : '';
    h += `<th data-field="${f}" class="${sorted}">${labels[i]}<span class="sort-arrow">${arrow}</span></th>`;
  }
  h += '<th class="col-actions">操作</th></tr></thead>';
  return h;
}

function renderProviderRow(p, idx) {
  const strat = strategyLabel(p.key_rotation_strategy);
  const badge = p.enabled !== false
    ? '<span class="badge badge-on">启用</span>'
    : '<span class="badge badge-off">停用</span>';
  return `<tr>
    <td class="col-id">${esc(p.provider_id)}</td>
    <td class="col-url" title="${esc(p.base_url)}">${esc(p.base_url)}</td>
    <td class="col-strategy">${strat}</td>
    <td>${badge}</td>
    <td class="col-actions">
      <button class="btn-icon edit-btn" data-idx="${idx}">编辑</button>
      <button class="btn-icon danger delete-btn" data-idx="${idx}">删除</button>
    </td>
  </tr>`;
}

function renderModelRow(m, idx, providerIds) {
  const badge = m.enabled !== false
    ? '<span class="badge badge-on">启用</span>'
    : '<span class="badge badge-off">停用</span>';
  return `<tr>
    <td class="col-model">${esc(m.client_model)}</td>
    <td>${esc(m.provider_id)}</td>
    <td>${esc(m.upstream_model)}</td>
    <td>${badge}</td>
    <td class="col-actions">
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

function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

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
      if (isProvider) currentConfig.providers[editingIndex] = item;
      else currentConfig.models[editingIndex] = item;
    } else {
      if (isProvider) currentConfig.providers.push(item);
      else currentConfig.models.push(item);
    }
    closeModal();
    refreshDefaultModelSelect();
    renderTable();
    updatePreviewNow();
  } catch (e) {
    alert(e.message);
  }
}

function providerFormHtml(item) {
  const p = item || {};
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
        <span class="form-label">base_url *</span>
        <input id="mf-base_url" type="text" value="${esc(p.base_url)}" placeholder="https://integrate.api.nvidia.com/v1" />
      </div>
      <div class="form-group">
        <span class="form-label">api_key_env</span>
        <input id="mf-api_key_env" type="text" value="${esc(p.api_key_env)}" placeholder="多个 key 用逗号分隔" />
      </div>
      <div class="form-group">
        <span class="form-label">api_key（多个 key 用逗号分隔）</span>
        <input id="mf-api_key" type="password" value="${esc(p.api_key)}" placeholder="留空则使用环境变量" />
      </div>
      <div class="form-group">
        <span class="form-label">API Key 切换策略</span>
        <select id="mf-key_rotation_strategy">
          <option value="round_robin" ${(p.key_rotation_strategy||'round_robin')==='round_robin'?'selected':''}>轮询 (Round-Robin)</option>
          <option value="on_429" ${p.key_rotation_strategy==='on_429'?'selected':''}>遇 429 自动切换</option>
        </select>
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
  return {
    provider_id,
    provider_type: 'openai_compatible',
    base_url,
    api_key: $('#mf-api_key').value.trim() || null,
    api_key_env: $('#mf-api_key_env').value.trim() || null,
    key_rotation_strategy: $('#mf-key_rotation_strategy').value || 'round_robin',
    timeout_seconds: Number($('#mf-timeout_seconds').value || 300),
    stream_idle_timeout_seconds: Number($('#mf-stream_idle_timeout_seconds').value || 120),
    enabled: $('#mf-enabled').checked,
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

// ── Init ──
ensureSession().then(loadConfig).catch(e => setStatus(e.message, true));
