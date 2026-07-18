import { Dialog, Toast, Theme, closeInfoTips, enhanceInfoTips, escapeHtml as esc, replaceSelectOptions } from './admin-ui.js';
import { AdminApi, ApiClientError } from './api-client.js';
import { createAdminStore } from './store.js';
import { collectProviderForm, providerFormHtml } from './forms/provider-form.js';
import { collectModelForm, modelFormHtml } from './forms/model-form.js';
import { readQuotaInputs } from './forms/shared.js';
import { renderPagination, renderTableHead } from './components/data-table.js';
import { renderChangePreview, renderConfigHistory, renderSummary } from './views/summary-view.js';
import { renderModelRow, renderProviderRow } from './views/resource-rows.js';
import { renderKeyPanelHtml } from './views/key-panel.js';
import { renderActivityView } from './views/activity-view.js';

// ── State ──
const state = createAdminStore();
let currentTab = 'providers';
let editingIndex = -1;        // -1 = add new
let providerPage = 1;
let modelPage = 1;
const PAGE_SIZE = 10;
let expandedKeyProvider = localStorage.getItem('ccop-expanded-key-provider') || null; // provider_id of expanded key panel

// sort state per tab
const sortState = {
  providers: { field: null, asc: true },
  models: { field: null, asc: true },
};

// 模型映射筛选：按模型名（客户端/上游）和供应商过滤
let modelFilter = { name: '', provider: '' };
let activityFilter = 'all';
let unreadActivityCount = 0;
let eventSource = null;
let activityRenderScheduled = false;

// ── DOM refs ──
const $ = (sel) => document.querySelector(sel);

const statusBox = $('#status');
const summaryWrap = $('#summary');
const preview = $('#configChangePreview');
const configHistory = $('#configHistory');
const refreshHistoryBtn = $('#refreshHistoryBtn');
const defaultClientModel = $('#defaultClientModel');
const proxyAuthTokenInput = $('#proxyAuthToken');
const proxyTokenStatus = $('#proxyTokenStatus');
const rotateProxyTokenBtn = $('#rotateProxyTokenBtn');
const clearProxyTokenBtn = $('#clearProxyTokenBtn');
const keyMaxErrorsInput = $('#keyMaxErrors');
const antiBanModeInput = $('#antiBanMode');
const antiBanMaxConcurrentInput = $('#antiBanMaxConcurrent');
const antiBanMinIntervalInput = $('#antiBanMinInterval');
const antiBanDelayMinInput = $('#antiBanDelayMin');
const antiBanDelayMaxInput = $('#antiBanDelayMax');
const antiBanKeySelectionInput = $('#antiBanKeySelection');
const antiBanStickyOnCooldownInput = $('#antiBanStickyOnCooldown');
const antiBanRetryMaxAttemptsInput = $('#antiBanRetryMaxAttempts');
const antiBanRetryMaxTotalMsInput = $('#antiBanRetryMaxTotalMs');
const antiBanRetryOnRateLimitInput = $('#antiBanRetryOnRateLimit');
const antiBanRetryOnTransientInput = $('#antiBanRetryOnTransient');
const antiBanQuotaPersistEveryInput = $('#antiBanQuotaPersistEvery');
const antiBanQuotaCriticalInput = $('#antiBanQuotaCritical');
const antiBanQuotaUsageFileInput = $('#antiBanQuotaUsageFile');
const tabProviders = $('#tab-providers');
const tabModels = $('#tab-models');
const tabActivity = $('#tab-activity');
const modelFilterBar = $('#model-filter-bar');
const modelFilterName = $('#modelFilterName');
const modelFilterProvider = $('#modelFilterProvider');
const tableContainer = $('#table-container');

function setStatus(text, isError) {
  statusBox.textContent = text;
  statusBox.className = 'status-bar ' + (isError ? 'error' : (text.includes('...') ? 'loading' : 'success'));
}

async function ensureSession() {
  const { data } = await AdminApi.session();
  if (!data.authenticated) { window.location.href = '/login'; throw new Error('未登录'); }
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

function openQuotaEditor(providerId, keyId, current, displayIndex) {
  const c = current || {};
  const reqVal = c.max_requests != null ? c.max_requests : '';
  const tokVal = c.max_tokens != null ? c.max_tokens : '';
  const costVal = c.max_cost_usd != null ? c.max_cost_usd : '';
  const inputCostVal = c.input_cost_per_million != null ? c.input_cost_per_million : '';
  const outputCostVal = c.output_cost_per_million != null ? c.output_cost_per_million : '';
  const thrVal = c.soft_stop_threshold != null ? c.soft_stop_threshold : '';
  const html = `
    <p class="form-hint">本地软停用配额：达到 上限 × 软停阈值 时让 Key 自动离开候选池；用户配置 enabled 不变，调用 /reset 或重置配额后立即恢复。三项留空 = 清除配额。</p>
    <div class="form-grid">
      <div class="form-group">
        <div class="form-label-row"><span class="form-label">请求次数上限</span><span class="field-key">max_requests</span></div>
        <input id="qf-max-req" type="number" min="1" value="${esc(reqVal)}" placeholder="留空 = 不限"/>
      </div>
      <div class="form-group">
        <div class="form-label-row"><span class="form-label">Token 总量上限</span><span class="field-key">max_tokens</span></div>
        <input id="qf-max-tok" type="number" min="1" value="${esc(tokVal)}" placeholder="留空 = 不限"/>
      </div>
      <div class="form-group">
        <div class="form-label-row"><span class="form-label">软停阈值 (0,1]</span><span class="field-key">soft_stop_threshold</span></div>
        <input id="qf-threshold" type="number" min="0" max="1" step="0.01" value="${esc(thrVal)}" placeholder="0.95"/>
      </div>
      <div class="form-group">
        <div class="form-label-row"><span class="form-label">费用上限</span><span class="field-key">max_cost_usd</span><span class="form-label-unit">USD</span></div>
        <input id="qf-max-cost" type="number" min="0" step="0.000001" value="${esc(costVal)}" placeholder="留空 = 不限"/>
      </div>
      <div class="form-group">
        <div class="form-label-row"><span class="form-label">输入单价</span><span class="field-key">input_cost_per_million</span><span class="form-label-unit">USD / 1M Token</span></div>
        <input id="qf-input-cost" type="number" min="0" step="0.000001" value="${esc(inputCostVal)}" placeholder="例如 3"/>
      </div>
      <div class="form-group">
        <div class="form-label-row"><span class="form-label">输出单价</span><span class="field-key">output_cost_per_million</span><span class="form-label-unit">USD / 1M Token</span></div>
        <input id="qf-output-cost" type="number" min="0" step="0.000001" value="${esc(outputCostVal)}" placeholder="例如 15"/>
      </div>
    </div>`;
  Dialog.show(`编辑配额 — ${providerId} #${displayIndex + 1}`, html, [
    { text: '取消', class: 'btn-secondary' },
    { text: '保存', class: 'btn-primary', action: () => submitQuota(providerId, keyId) }
  ]);
}

async function submitQuota(providerId, keyId) {
  let quota;
  try {
    quota = readQuotaInputs('qf');
  } catch (err) {
    Toast.error(err.message);
    return;
  }
  try {
    const { data, revision } = await AdminApi.updateKeyQuota(providerId, keyId, quota);
    if (revision) state.revision = revision;
    setStatus(data.message || '配额已更新');
    Toast.success(data.message || '配额已更新');
    await loadConfig();
  } catch (error) {
    Toast.error(`保存失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

function antiBanDefaults(mode) {
  return mode === 'throughput'
    ? { mode: 'throughput', max_concurrent: 3, min_interval_ms: 100, rate_limit_delay_min_ms: 1000, rate_limit_delay_max_ms: 3000 }
    : { mode: 'conservative', max_concurrent: 1, min_interval_ms: 1000, rate_limit_delay_min_ms: 5000, rate_limit_delay_max_ms: 10000 };
}

function readPositiveInt(input) {
  const v = parseInt(input.value, 10);
  return Number.isFinite(v) && v > 0 ? v : null;
}

function readNonNegativeInt(input) {
  const v = parseInt(input.value, 10);
  return Number.isFinite(v) && v >= 0 ? v : null;
}

function readRatio(input) {
  if (!input.value.trim()) return null;
  const v = Number(input.value);
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : null;
}

function readPositiveFloat(input) {
  if (!input.value.trim()) return null;
  const v = Number(input.value);
  return Number.isFinite(v) && v >= 0 ? v : null;
}

function setNumberInput(input, value) {
  input.value = value == null ? '' : value;
}

function readAntiBanConfig() {
  const mode = antiBanModeInput.value === 'throughput' ? 'throughput' : 'conservative';
  const defaults = antiBanDefaults(mode);
  const maxConcurrent = readPositiveInt(antiBanMaxConcurrentInput) ?? defaults.max_concurrent;
  const minInterval = readNonNegativeInt(antiBanMinIntervalInput) ?? defaults.min_interval_ms;
  const delayMin = readNonNegativeInt(antiBanDelayMinInput) ?? defaults.rate_limit_delay_min_ms;
  const delayMaxRaw = readNonNegativeInt(antiBanDelayMaxInput);
  const delayMax = delayMaxRaw != null && delayMaxRaw >= delayMin
    ? delayMaxRaw
    : Math.max(delayMin, defaults.rate_limit_delay_max_ms);

  const result = {
    mode,
    max_concurrent: maxConcurrent,
    min_interval_ms: minInterval,
    rate_limit_delay_min_ms: delayMin,
    rate_limit_delay_max_ms: delayMax,
    key_selection: antiBanKeySelectionInput.value === 'balanced' ? 'balanced' : 'sticky',
    sticky_on_cooldown: antiBanStickyOnCooldownInput.value === 'wait' ? 'wait' : 'fallthrough',
  };

  const retry = {};
  const retryAttempts = readPositiveInt(antiBanRetryMaxAttemptsInput);
  if (retryAttempts != null) retry.max_attempts = retryAttempts;
  const retryTotal = readNonNegativeInt(antiBanRetryMaxTotalMsInput);
  if (retryTotal != null) retry.max_total_ms = retryTotal;
  retry.retry_on_rate_limit = antiBanRetryOnRateLimitInput.checked;
  retry.retry_on_transient = antiBanRetryOnTransientInput.checked;
  result.retry = retry;

  const quota = {};
  const persistEvery = readNonNegativeInt(antiBanQuotaPersistEveryInput);
  if (persistEvery != null) quota.persist_every_n_requests = persistEvery;
  const critical = readRatio(antiBanQuotaCriticalInput);
  if (critical != null) quota.persist_critical_threshold = critical;
  const usageFile = antiBanQuotaUsageFileInput.value.trim();
  if (usageFile) quota.usage_file = usageFile;
  if (Object.keys(quota).length > 0) result.quota = quota;

  return result;
}

function fillAntiBanConfig(config) {
  const cfg = config || {};
  const mode = cfg.mode === 'throughput' ? 'throughput' : 'conservative';
  const defaults = antiBanDefaults(mode);
  antiBanModeInput.value = mode;
  antiBanMaxConcurrentInput.value = cfg.max_concurrent ?? defaults.max_concurrent;
  antiBanMinIntervalInput.value = cfg.min_interval_ms ?? defaults.min_interval_ms;
  antiBanDelayMinInput.value = cfg.rate_limit_delay_min_ms ?? defaults.rate_limit_delay_min_ms;
  antiBanDelayMaxInput.value = cfg.rate_limit_delay_max_ms ?? defaults.rate_limit_delay_max_ms;
  antiBanKeySelectionInput.value = cfg.key_selection === 'balanced' ? 'balanced' : 'sticky';
  antiBanStickyOnCooldownInput.value = cfg.sticky_on_cooldown === 'wait' ? 'wait' : 'fallthrough';

  const retry = cfg.retry || {};
  setNumberInput(antiBanRetryMaxAttemptsInput, retry.max_attempts);
  setNumberInput(antiBanRetryMaxTotalMsInput, retry.max_total_ms);
  antiBanRetryOnRateLimitInput.checked = retry.retry_on_rate_limit !== false;
  antiBanRetryOnTransientInput.checked = retry.retry_on_transient !== false;

  const quota = cfg.quota || {};
  setNumberInput(antiBanQuotaPersistEveryInput, quota.persist_every_n_requests);
  setNumberInput(antiBanQuotaCriticalInput, quota.persist_critical_threshold);
  antiBanQuotaUsageFileInput.value = quota.usage_file || '';
}

// ── API ──
async function loadConfig() {
  try {
    setStatus('正在加载配置...');
    const { data, revision } = await AdminApi.loadConfig();
    state.applyServerView(data, revision);
    renderSummary(summaryWrap, data.summary);
    renderProxyTokenState();
    keyMaxErrorsInput.value = state.config.key_max_errors || '';
    fillAntiBanConfig(state.config.anti_ban);
    refreshDefaultModelSelect();
    renderTable();
    void updatePreviewNow();
    void loadHistory();
    setStatus('配置已加载');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(`加载失败：${message}`, true);
    Toast.error(`加载失败：${message}`);
  }
}

async function loadHistory() {
  try {
    const { data, revision } = await AdminApi.loadConfigHistory(20);
    if (revision) state.revision = revision;
    renderConfigHistory(configHistory, data.history || []);
  } catch (error) {
    configHistory.innerHTML = `<div class="empty-state">加载失败：${esc(error instanceof Error ? error.message : String(error))}</div>`;
  }
}

async function rollbackHistory(targetRevision) {
  try {
    setStatus(`正在回滚到 revision ${targetRevision}...`);
    const { data, revision } = await AdminApi.rollbackConfig(targetRevision, state.revision);
    if (revision) state.revision = revision;
    Toast.success(data.message || '配置已回滚');
    await loadConfig();
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 409) {
      showConfigConflict(error.data);
      return;
    }
    setStatus(`回滚失败：${error instanceof Error ? error.message : String(error)}`, true);
    Toast.error(`回滚失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

function buildPayload() {
  const keyMaxErrorsVal = parseInt(keyMaxErrorsInput.value, 10);
  return {
    ...state.config,
    default_client_model: defaultClientModel.value || null,
    key_max_errors: Number.isFinite(keyMaxErrorsVal) && keyMaxErrorsVal > 0 ? keyMaxErrorsVal : null,
    anti_ban: readAntiBanConfig(),
  };
}

async function saveConfig() {
  try {
    setStatus('正在保存配置...');
    const payload = buildPayload();
    const { data, revision } = await AdminApi.saveConfig(payload, state.revision);
    state.applyServerView(data, revision);
    renderSummary(summaryWrap, data.summary);
    refreshDefaultModelSelect();
    renderTable();
    renderProxyTokenState();
    void updatePreviewNow();
    setStatus(data.message || '保存成功');
    Toast.success(data.message || '配置已保存并生效');
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 409) {
      showConfigConflict(error.data);
      return;
    }
    setStatus('保存失败：' + error.message, true);
    Toast.error('保存失败：' + error.message);
  }
}

async function loadKeyStates(providerId) {
  try {
    const { data, revision } = await AdminApi.loadKeys(providerId);
    if (revision) state.revision = revision;
    state.setProviderKeys(providerId, data.keys || []);
    return data.keys || [];
  } catch {
    return [];
  }
}

async function keyAction(providerId, keyId, action) {
  try {
    const { data, revision } = await AdminApi.keyAction(providerId, keyId, action);
    if (revision) state.revision = revision;
    setStatus(data.message || '操作成功');
    Toast.success(data.message || '操作成功');
    await loadKeyStates(providerId);
    await loadConfig();
    renderKeyPanel(providerId);
  } catch (err) {
    setStatus('操作失败：' + err.message, true);
    Toast.error('操作失败：' + err.message);
  }
}

// ── Render ──
function refreshDefaultModelSelect() {
  const ids = state.config.models.filter(m => m.enabled !== false).map(m => m.client_model).filter(Boolean);
  const old = defaultClientModel.value;
  const selected = ids.includes(old) ? old : (state.config.default_client_model || '');
  replaceSelectOptions(
    defaultClientModel,
    ids.map((id) => ({ value: id, label: id })),
    selected,
    '未设置'
  );
}

let updatePreviewTimer = null;
let previewController = null;
function updatePreview() {
  clearTimeout(updatePreviewTimer);
  updatePreviewTimer = setTimeout(() => void requestConfigPreview(), 300);
}

async function updatePreviewNow() {
  clearTimeout(updatePreviewTimer);
  await requestConfigPreview();
}

async function requestConfigPreview() {
  if (!state.revision) return;
  previewController?.abort();
  previewController = new AbortController();
  try {
    const { data } = await AdminApi.previewConfig(buildPayload(), state.revision, previewController.signal);
    renderChangePreview(preview, data);
  } catch (error) {
    if (error?.name === 'AbortError') return;
    if (error instanceof ApiClientError && error.status === 409) {
      preview.textContent = '配置已被其他会话更新，请重新加载。';
      return;
    }
    preview.textContent = `预览失败：${error instanceof Error ? error.message : String(error)}`;
  }
}

function showConfigConflict(data) {
  setStatus('保存失败：配置已被其他会话更新', true);
  Dialog.confirm(
    '配置冲突',
    `服务器配置已更新到 revision ${data?.revision || '未知'}。重新加载后再应用本次修改。`,
    () => void loadConfig(),
  );
}

function renderProxyTokenState() {
  proxyAuthTokenInput.value = '';
  proxyAuthTokenInput.placeholder = state.proxyTokenConfigured ? '已配置，输入新值可轮换' : '输入新 Token';
  proxyTokenStatus.textContent = state.proxyTokenConfigured ? '当前已配置代理鉴权 Token。' : '当前未配置代理鉴权 Token。';
  clearProxyTokenBtn.disabled = !state.proxyTokenConfigured;
}

async function updateProxyToken(token) {
  let result;
  try {
    result = await AdminApi.updateProxyToken(token, state.revision);
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 409) {
      showConfigConflict(error.data);
      return;
    }
    throw error;
  }
  const { data, revision } = result;
  state.revision = revision || data.revision;
  state.proxyTokenConfigured = Boolean(data.proxy_auth_token_configured);
  renderProxyTokenState();
  setStatus(data.message || 'Token 已更新');
  Toast.success(data.message || 'Token 已更新');
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

// 用当前供应商列表同步筛选下拉框选项，保留已选中的值。
function syncModelFilterProviderOptions() {
  const ids = state.config.providers.map(p => p.provider_id).filter(Boolean);
  const current = modelFilter.provider;
  replaceSelectOptions(
    modelFilterProvider,
    ids.map((id) => ({ value: id, label: id })),
    ids.includes(current) ? current : '',
    '全部供应商'
  );
  modelFilter.provider = modelFilterProvider.value;
}

// 按模型名（客户端 / 上游，大小写不敏感）和供应商筛选模型映射。
function filterModels(models) {
  const name = modelFilter.name.trim().toLowerCase();
  const provider = modelFilter.provider;
  if (!name && !provider) return models;
  return models.filter(m => {
    if (provider && m.provider_id !== provider) return false;
    if (name) {
      const hay = `${m.client_model || ''} ${m.upstream_model || ''}`.toLowerCase();
      if (!hay.includes(name)) return false;
    }
    return true;
  });
}

// ── Table ──
function renderTable() {
  if (currentTab === 'activity') {
    modelFilterBar.style.display = 'none';
    tableContainer.innerHTML = renderActivityView(state.activities, {
      connected: state.eventConnected,
      filter: activityFilter,
    });
    return;
  }
  const isProvider = currentTab === 'providers';
  const items = isProvider ? state.config.providers : state.config.models;
  // 模型 tab 支持按名称 / 供应商筛选；供应商 tab 不筛选。
  const displayItems = isProvider ? items : filterModels(items);
  modelFilterBar.style.display = isProvider ? 'none' : '';
  if (!isProvider) syncModelFilterProviderOptions();
  const st = sortState[currentTab];
  const sorted = sortItems(displayItems, st.field, st.asc);
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

  let html = '<div class="card">';
  html += '<div class="table-toolbar">';
  html += `<span class="section-subtitle" style="margin:0">${isProvider ? '供应商列表' : '模型映射列表'}（共 ${sorted.length} 条）</span>`;
  html += `<button class="btn btn-primary btn-small" id="addBtn">+ 新增${isProvider ? '供应商' : '模型映射'}</button>`;
  html += '</div>';

  if (sorted.length === 0) {
    html += '<div class="empty-state"><p>暂无数据</p></div>';
  } else {
    html += '<div class="table-scroll"><table class="data-table">';
    if (isProvider) {
      html += renderTableHead(['provider_id','provider_type','base_url','key_rotation_strategy','enabled'], st, ['ID','类型','URL','切换策略','状态']);
    } else {
      html += renderTableHead(['client_model','provider_id','upstream_model','priority','weight','enabled'], st, ['客户端模型','供应商','上游模型','优先级','权重','状态']);
    }
    html += '<tbody>';
    for (let i = 0; i < pageItems.length; i++) {
      const item = pageItems[i];
      const realIdx = idxMap.get(item);
      if (isProvider) {
        html += renderProviderRow(item, realIdx, expandedKeyProvider, state.runtimeSettings);
        if (expandedKeyProvider === item.provider_id) {
          const keys = state.keyStates[item.provider_id] || getKeyArray(item);
          html += renderKeyPanelHtml(item.provider_id, keys);
        }
      } else {
        html += renderModelRow(item, realIdx);
      }
    }
    html += '</tbody></table></div>';
  }

  html += renderPagination(clampedPage, totalPages, sorted.length);
  html += '</div>';
  tableContainer.innerHTML = html;
}

function changePage(dir) {
  if (currentTab === 'providers') {
    const total = Math.max(1, Math.ceil(state.config.providers.length / PAGE_SIZE));
    providerPage = Math.max(1, Math.min(total, providerPage + dir));
  } else {
    const total = Math.max(1, Math.ceil(state.config.models.length / PAGE_SIZE));
    modelPage = Math.max(1, Math.min(total, modelPage + dir));
  }
  renderTable();
}

function moveItem(idx, dir) {
  const arr = currentTab === 'providers' ? state.config.providers : state.config.models;
  const newIdx = idx + dir;
  if (newIdx < 0 || newIdx >= arr.length) return;
  [arr[idx], arr[newIdx]] = [arr[newIdx], arr[idx]];
  renderTable();
  updatePreviewNow();
}

async function toggleKeyPanel(providerId) {
  if (expandedKeyProvider === providerId) {
    expandedKeyProvider = null;
    localStorage.removeItem('ccop-expanded-key-provider');
    renderTable();
    return;
  }
  expandedKeyProvider = providerId;
  localStorage.setItem('ccop-expanded-key-provider', providerId);
  await loadKeyStates(providerId);
  renderTable();
}

async function renderKeyPanel(providerId) {
  await loadKeyStates(providerId);
  renderTable();
}

async function updateKeyNote(providerId, keyId, note) {
  try {
    const { revision } = await AdminApi.updateKeyNote(providerId, keyId, note);
    if (revision) state.revision = revision;
    await loadConfig();
  } catch (error) {
    Toast.error(`备注更新失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function addProviderKeys(providerId, keys, input) {
  try {
    const { data, revision } = await AdminApi.addKeys(providerId, keys);
    if (revision) state.revision = revision;
    setStatus(data.message || `${keys.length} 个 Key 已添加到 ${providerId}`);
    Toast.success(data.message || `${keys.length} 个 Key 已添加`);
    input.value = '';
    await loadConfig();
  } catch (error) {
    Toast.error(`添加失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function resetProviderKeys(providerId) {
  try {
    const { data, revision } = await AdminApi.resetAllKeys(providerId);
    if (revision) state.revision = revision;
    setStatus(data.message || `${providerId} 所有 Key 已重置`);
    Toast.success(data.message || `${providerId} 所有 Key 已重置`);
    await loadConfig();
  } catch (error) {
    Toast.error(`重置失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function testProvider(providerId, button) {
  const originalText = button?.textContent || '测试';
  if (button) {
    button.disabled = true;
    button.textContent = '测试中';
  }
  try {
    const { data } = await AdminApi.testProvider(providerId);
    setStatus(data.message || 'Provider 连接测试完成', !data.ok);
    if (data.ok) Toast.success(`${providerId} 连接成功（${data.latencyMs ?? data.latency_ms ?? 0} ms）`);
    else Toast.error(data.message || `${providerId} 连接失败`);
  } catch (error) {
    Toast.error(`连接测试失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

async function deleteProviderKey(providerId, keyId) {
  try {
    const { revision } = await AdminApi.deleteKey(providerId, keyId);
    if (revision) state.revision = revision;
    setStatus(`Key 已从 ${providerId} 删除`);
    Toast.success('Key 已删除');
    await loadConfig();
  } catch (error) {
    Toast.error(`删除失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function resetProviderKeyQuota(providerId, keyId) {
  try {
    const { data } = await AdminApi.resetKeyQuota(providerId, keyId);
    setStatus(data.message || '配额计数已清零');
    Toast.success(data.message || '配额计数已清零');
    await renderKeyPanel(providerId);
  } catch (error) {
    Toast.error(`重置配额失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

tableContainer.addEventListener('change', (e) => {
  const input = e.target;
  if (input.id === 'activityFilter') {
    activityFilter = input.value;
    renderTable();
    return;
  }
  if (input.classList.contains('key-note-input')) {
    const providerId = input.dataset.provider;
    const keyId = input.dataset.keyId;
    const note = input.value.trim();
    void updateKeyNote(providerId, keyId, note);
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
      const arr = type === 'provider' ? state.config.providers : state.config.models;
      if (idx >= 0 && idx < arr.length) {
        arr[idx].enabled = arr[idx].enabled === false ? true : false;
        renderTable();
        updatePreviewNow();
      }
    } else if (type === 'key') {
      const providerId = toggleTarget.dataset.provider;
      const keyId = toggleTarget.dataset.keyId;
      const keys = state.keyStates[providerId];
      const key = keys?.find((item) => item.id === keyId);
      if (key) {
        const action = key.enabled ? 'disable' : 'enable';
        keyAction(providerId, keyId, action);
      }
    }
    return;
  }

  const target = e.target.closest('button');
  if (!target) return;

  if (target.id === 'clearActivityBtn') {
    state.clearActivities();
    unreadActivityCount = 0;
    updateActivityTabCount();
    renderTable();
    return;
  }

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

  if (target.classList.contains('provider-test-btn')) {
    void testProvider(target.dataset.provider, target);
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
    // provider_id 允许普通配置字符，不能直接插入 CSS 选择器；从当前面板局部查找更安全。
    const input = target.closest('.key-panel')?.querySelector('.key-add-input');
    const raw = input?.value || '';
    const keys = raw.split(/[,，\n]+/).map(k => k.trim()).filter(Boolean);
    if (keys.length === 0) {
      Toast.info('请输入至少一个 Key 值');
      return;
    }
    void addProviderKeys(providerId, keys, input);
    return;
  }

  if (target.classList.contains('key-reset-all-btn')) {
    const providerId = target.dataset.provider;
    Dialog.confirm('确认重置', `确定要重置 ${providerId} 的所有 Key 错误计数并重新启用吗？`, () => {
      void resetProviderKeys(providerId);
    }, '确认重置', '取消', 'btn-warning');
    return;
  }

  if (target.classList.contains('key-delete-btn')) {
    const providerId = target.dataset.provider;
    const keyId = target.dataset.keyId;
    const displayIndex = Number(target.dataset.displayIndex);
    Dialog.confirm('确认删除', `确定要删除 ${providerId} 的第 ${displayIndex + 1} 个 Key 吗？`, () => {
      void deleteProviderKey(providerId, keyId);
    }, '确认删除', '取消', 'btn-danger');
    return;
  }

  if (target.classList.contains('key-quota-edit-btn')) {
    const providerId = target.dataset.provider;
    const keyId = target.dataset.keyId;
    const displayIndex = Number(target.dataset.displayIndex);
    const keys = state.keyStates[providerId] || [];
    const current = keys.find((item) => item.id === keyId)?.quota || null;
    openQuotaEditor(providerId, keyId, current, displayIndex);
    return;
  }

  if (target.classList.contains('key-quota-reset-btn')) {
    const providerId = target.dataset.provider;
    const keyId = target.dataset.keyId;
    const displayIndex = Number(target.dataset.displayIndex);
    Dialog.confirm('确认重置配额', `确定要清零 ${providerId} 第 ${displayIndex + 1} 个 Key 的本地配额计数吗？`, () => {
      void resetProviderKeyQuota(providerId, keyId);
    }, '确认重置', '取消', 'btn-warning');
    return;
  }

  if (target.classList.contains('key-action-btn')) {
    const providerId = target.dataset.provider;
    const keyId = target.dataset.keyId;
    const action = target.dataset.action;
    if (action === 'reset') {
      Dialog.confirm('确认重置', `确定要重置该 Key 的错误计数并重新启用吗？`, () => {
        keyAction(providerId, keyId, action);
      });
    } else {
      keyAction(providerId, keyId, action);
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
    const itemName = isProvider ? state.config.providers[idx]?.provider_id : state.config.models[idx]?.client_model;
    Dialog.confirm('确认删除', `确定要删除 "${itemName || '此项目'}" 吗？此操作不可撤销。`, () => {
      if (isProvider) {
        state.config.providers.splice(idx, 1);
      } else {
        state.config.models.splice(idx, 1);
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
  const item = isEdit ? (isProvider ? state.config.providers[idx] : state.config.models[idx]) : null;
  const title = `${isEdit ? '编辑' : '新增'}${isProvider ? '供应商' : '模型映射'}`;
  const content = isProvider
    ? providerFormHtml(item)
    : modelFormHtml(item, state.config.providers);
  Dialog.show(title, content, [
    { text: '取消', class: 'btn-secondary' },
    { text: '确认', class: 'btn-primary', action: submitModal, close: false },
  ], {
    size: 'large',
    onClose: () => { editingIndex = -1; },
  });
  enhanceInfoTips(Dialog.overlay);
}

function closeModal() {
  Dialog.hide();
}

function submitModal() {
  const isProvider = currentTab === 'providers';
  try {
    const item = isProvider ? collectProviderForm() : collectModelForm();
    if (editingIndex >= 0) {
      if (isProvider) {
        const existing = state.config.providers[editingIndex];
        const existingKeys = getKeyArray(existing);
        item.api_key = existingKeys.length > 0 ? existingKeys : null;
        if (existing.anti_ban) item.anti_ban = existing.anti_ban;
        state.config.providers[editingIndex] = item;
      }
      else {
        // 路由 ID 是服务端资源身份，编辑表单只修改字段，不能因替换对象而丢失。
        item.route_id = state.config.models[editingIndex].route_id;
        state.config.models[editingIndex] = item;
      }
    } else {
      if (isProvider) {
        state.config.providers.push(item);
      }
      else state.config.models.push(item);
    }
    closeModal();
    refreshDefaultModelSelect();
    renderTable();
    updatePreviewNow();
  } catch (e) {
    Toast.error(e.message);
    return false;
  }
  return true;
}

// ── Tab switching ──
function switchTab(tab) {
  currentTab = tab;
  expandedKeyProvider = null;
  tabProviders.classList.toggle('active', tab === 'providers');
  tabModels.classList.toggle('active', tab === 'models');
  tabActivity.classList.toggle('active', tab === 'activity');
  if (tab === 'activity') {
    unreadActivityCount = 0;
    updateActivityTabCount();
  }
  renderTable();
}

function connectAdminEvents() {
  eventSource?.close();
  eventSource = AdminApi.openEventStream({
    onEvent: (event) => {
      state.addActivity(event);
      if (currentTab === 'activity') scheduleActivityRender();
      else {
        unreadActivityCount = Math.min(99, unreadActivityCount + 1);
        updateActivityTabCount();
      }
    },
    onOpen: () => {
      state.eventConnected = true;
      if (currentTab === 'activity') scheduleActivityRender();
    },
    onError: () => {
      state.eventConnected = false;
      if (currentTab === 'activity') scheduleActivityRender();
    },
  });
}

function scheduleActivityRender() {
  if (activityRenderScheduled) return;
  activityRenderScheduled = true;
  requestAnimationFrame(() => {
    activityRenderScheduled = false;
    if (currentTab === 'activity') renderTable();
  });
}

function updateActivityTabCount() {
  const count = tabActivity.querySelector('.tab-count');
  if (count) count.textContent = unreadActivityCount > 0 ? String(unreadActivityCount) : '';
}

// ── Events ──
tabProviders.addEventListener('click', () => switchTab('providers'));
tabModels.addEventListener('click', () => switchTab('models'));
tabActivity.addEventListener('click', () => switchTab('activity'));
$('#refreshBtn').addEventListener('click', loadConfig);
refreshHistoryBtn.addEventListener('click', loadHistory);
configHistory.addEventListener('click', (event) => {
  const button = event.target.closest('.history-rollback-btn');
  if (!button || button.disabled) return;
  const targetRevision = Number(button.dataset.revision);
  if (!Number.isSafeInteger(targetRevision) || targetRevision <= 0) return;
  Dialog.confirm(
    '确认回滚配置',
    `基于 revision ${targetRevision} 创建新版本，并恢复当时的供应商、路由与凭证配置。`,
    () => void rollbackHistory(targetRevision),
    '确认回滚',
    '取消',
    'btn-danger',
  );
});
$('#saveBtn').addEventListener('click', saveConfig);
$('#logoutBtn').addEventListener('click', async () => {
  try {
    eventSource?.close();
    await AdminApi.logout();
  } finally {
    window.location.href = '/login';
  }
});
defaultClientModel.addEventListener('change', updatePreview);
rotateProxyTokenBtn.addEventListener('click', async () => {
  const token = proxyAuthTokenInput.value.trim();
  if (!token) {
    Toast.error('请输入新的代理鉴权 Token');
    proxyAuthTokenInput.focus();
    return;
  }

  try {
    await updateProxyToken(token);
  } catch (error) {
    Toast.error(`Token 更新失败：${error instanceof Error ? error.message : String(error)}`);
  }
});
clearProxyTokenBtn.addEventListener('click', () => {
  Dialog.confirm('移除代理鉴权', '移除后代理接口将不再校验 Token，确定继续吗？', async () => {
    try {
      await updateProxyToken(null);
    } catch (error) {
      Toast.error(`Token 移除失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }, '确认移除', '取消', 'btn-danger');
});
keyMaxErrorsInput.addEventListener('input', updatePreview);
modelFilterName.addEventListener('input', () => { modelFilter.name = modelFilterName.value; modelPage = 1; renderTable(); });
modelFilterProvider.addEventListener('change', () => { modelFilter.provider = modelFilterProvider.value; modelPage = 1; renderTable(); });
antiBanModeInput.addEventListener('change', () => {
  const mode = antiBanModeInput.value === 'throughput' ? 'throughput' : 'conservative';
  const defaults = antiBanDefaults(mode);
  antiBanModeInput.value = mode;
  antiBanMaxConcurrentInput.value = defaults.max_concurrent;
  antiBanMinIntervalInput.value = defaults.min_interval_ms;
  antiBanDelayMinInput.value = defaults.rate_limit_delay_min_ms;
  antiBanDelayMaxInput.value = defaults.rate_limit_delay_max_ms;
  updatePreviewNow();
});
antiBanMaxConcurrentInput.addEventListener('input', updatePreview);
antiBanMinIntervalInput.addEventListener('input', updatePreview);
antiBanDelayMinInput.addEventListener('input', updatePreview);
antiBanDelayMaxInput.addEventListener('input', updatePreview);
antiBanKeySelectionInput.addEventListener('change', updatePreview);
antiBanStickyOnCooldownInput.addEventListener('change', updatePreview);
antiBanRetryMaxAttemptsInput.addEventListener('input', updatePreview);
antiBanRetryMaxTotalMsInput.addEventListener('input', updatePreview);
antiBanRetryOnRateLimitInput.addEventListener('change', updatePreview);
antiBanRetryOnTransientInput.addEventListener('change', updatePreview);
antiBanQuotaPersistEveryInput.addEventListener('input', updatePreview);
antiBanQuotaCriticalInput.addEventListener('input', updatePreview);
antiBanQuotaUsageFileInput.addEventListener('input', updatePreview);

// ── Init ──
Theme.init();
enhanceInfoTips();
document.addEventListener('click', () => closeInfoTips());
const themeToggleBtn = document.getElementById('themeToggleBtn');
if (themeToggleBtn) {
  themeToggleBtn.addEventListener('click', () => Theme.toggle());
}
window.addEventListener('beforeunload', () => eventSource?.close());
ensureSession().then(() => {
  connectAdminEvents();
  return loadConfig();
}).catch(e => setStatus(e.message, true));
