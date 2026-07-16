// ── State ──
let currentConfig = { providers: [], models: [], default_client_model: null, proxy_auth_token: null, anti_ban: null };
let currentTab = 'providers';
let editingIndex = -1;        // -1 = add new
let providerPage = 1;
let modelPage = 1;
const PAGE_SIZE = 10;
let expandedKeyProvider = localStorage.getItem('ccop-expanded-key-provider') || null; // provider_id of expanded key panel
let keyStates = {}; // { providerId: [ApiKeyEntry, ...] }

// sort state per tab
const sortState = {
  providers: { field: null, asc: true },
  models: { field: null, asc: true },
};

// 模型映射筛选：按模型名（客户端/上游）和供应商过滤
let modelFilter = { name: '', provider: '' };

// ── DOM refs ──
const $ = (sel) => document.querySelector(sel);

const statusBox = $('#status');
const summaryWrap = $('#summary');
const preview = $('#jsonPreview');
const defaultClientModel = $('#defaultClientModel');
const proxyAuthTokenInput = $('#proxyAuthToken');
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
const modelFilterBar = $('#model-filter-bar');
const modelFilterName = $('#modelFilterName');
const modelFilterProvider = $('#modelFilterProvider');
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
  escHandler: null,
  keydownHandler: null,
  previousFocus: null,

  init() {
    if (this.overlay) return;
    this.overlay = document.createElement('div');
    this.overlay.className = 'dialog-overlay';
    this.overlay.innerHTML = `
      <div class="dialog-container" role="dialog" aria-modal="true">
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
    this.previousFocus = document.activeElement;
    this.overlay.querySelector('.dialog-title').textContent = title;
    this.overlay.querySelector('.dialog-content').innerHTML = content;

    const footer = this.overlay.querySelector('.dialog-footer');
    footer.innerHTML = '';

    let primaryButton = null;
    buttons.forEach(btn => {
      const button = document.createElement('button');
      button.className = `btn ${btn.class || ''}`;
      button.textContent = btn.text;
      button.addEventListener('click', () => {
        if (btn.action) btn.action();
        if (btn.close !== false) this.hide();
      });
      footer.appendChild(button);
      if (btn.class && btn.class.includes('btn-primary')) primaryButton = button;
    });

    this.overlay.classList.add('show');

    // 键盘交互：Esc 关闭、Enter 触发首个 primary 按钮（除非焦点已在按钮上）
    this.keydownHandler = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.hide();
        return;
      }
      if (e.key === 'Enter' && primaryButton) {
        const tag = (e.target.tagName || '').toLowerCase();
        // textarea 内回车不拦截；其余区域回车触发 primary 按钮
        if (tag === 'textarea') return;
        if (tag === 'button') return;
        e.preventDefault();
        primaryButton.click();
      }
    };
    document.addEventListener('keydown', this.keydownHandler);

    // 把焦点移到第一个可交互元素，方便键盘用户立即输入
    setTimeout(() => {
      const focusTarget = this.overlay.querySelector('input, textarea, select, button.btn-primary') || primaryButton;
      if (focusTarget) focusTarget.focus();
    }, 0);
  },

  hide() {
    if (this.overlay) this.overlay.classList.remove('show');
    if (this.keydownHandler) {
      document.removeEventListener('keydown', this.keydownHandler);
      this.keydownHandler = null;
    }
    if (this.previousFocus && typeof this.previousFocus.focus === 'function') {
      try { this.previousFocus.focus(); } catch { /* ignore */ }
      this.previousFocus = null;
    }
  },

  confirm(title, message, onConfirm, confirmText = '确认', cancelText = '取消', confirmClass = 'btn-primary') {
    this.show(title, `<p>${esc(message)}</p>`, [
      { text: cancelText, class: 'btn-secondary' },
      { text: confirmText, class: confirmClass, action: onConfirm }
    ]);
  },

  alert(title, message, onClose) {
    this.show(title, `<p>${esc(message)}</p>`, [
      { text: '确定', class: 'btn-primary', action: onClose }
    ]);
  }
};

// ── Toast 通知 ──
// 叠加式右下角通知，3 秒自动消失。
// 替代 alert + 顶部 status-bar 在"操作完成"场景下的反馈，避免操作连发时旧消息被覆盖。
const Toast = {
  stack: null,
  ensureStack() {
    if (this.stack) return this.stack;
    this.stack = document.createElement('div');
    this.stack.className = 'toast-stack';
    document.body.appendChild(this.stack);
    return this.stack;
  },
  show(message, type = 'info', durationMs = 3000) {
    const stack = this.ensureStack();
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    const icon = type === 'success' ? '✓' : type === 'error' ? '!' : 'i';
    el.innerHTML = `
      <span class="toast-icon" aria-hidden="true">${icon}</span>
      <div class="toast-body"></div>
      <button class="toast-close" aria-label="关闭">×</button>
    `;
    el.querySelector('.toast-body').textContent = message;
    stack.appendChild(el);
    // 触发 transition：next frame 加 show
    requestAnimationFrame(() => el.classList.add('show'));

    let dismissed = false;
    const dismiss = () => {
      if (dismissed) return;
      dismissed = true;
      el.classList.remove('show');
      setTimeout(() => el.remove(), 250);
    };
    el.querySelector('.toast-close').addEventListener('click', dismiss);
    if (durationMs > 0) {
      setTimeout(dismiss, durationMs);
    }
  },
  success(message) { this.show(message, 'success'); },
  error(message) { this.show(message, 'error', 5000); },
  info(message) { this.show(message, 'info'); }
};

// ── 主题切换 ──
// 在 :root 上预定义的 CSS 变量基础上，通过 body.theme-light 覆盖颜色。
// 选择持久化在 localStorage，初始化在 DOMContentLoaded 之前完成以避免闪烁。
const Theme = {
  STORAGE_KEY: 'ccop-theme',
  current: 'dark',
  apply(name) {
    this.current = name === 'light' ? 'light' : 'dark';
    // 同时在 html 和 body 上挂 class：html 上的由内联脚本先设置避免闪烁，
    // body 上的是为了 CSS 选择器兼容（其余组件样式都基于 body）。
    document.documentElement.classList.toggle('theme-light', this.current === 'light');
    document.body.classList.toggle('theme-light', this.current === 'light');
    try { localStorage.setItem(this.STORAGE_KEY, this.current); } catch { /* localStorage 不可用时降级为仅本会话生效 */ }
    this.updateToggleButton();
  },
  toggle() {
    this.apply(this.current === 'dark' ? 'light' : 'dark');
  },
  updateToggleButton() {
    const btn = document.getElementById('themeToggleBtn');
    if (!btn) return;
    btn.setAttribute('aria-label', this.current === 'dark' ? '切换到亮色主题' : '切换到暗色主题');
    btn.innerHTML = this.current === 'dark'
      ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>`
      : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>`;
  },
  init() {
    let saved = 'dark';
    try { saved = localStorage.getItem(this.STORAGE_KEY) || 'dark'; } catch { /* ignore */ }
    // documentElement 上可能已被 inline 脚本设置过 theme-light（防闪烁）；
    // 在此再调一次 apply 以同步 body 和按钮图标。
    this.apply(saved);
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

function keyStatusLabel(status, key) {
  if (!key.enabled) return key.auto_disabled_at ? '自动禁用' : '已禁用';
  if (status === 'delayed') return '延迟中';
  if (status === 'busy') return `占满 ${key.active_requests}`;
  return '可用';
}

function keyErrorCategoryLabel(category) {
  const labels = {
    hard_limit: '硬限额',
    rate_limit: '限流',
    transient: '临时错误',
    network: '网络错误'
  };
  return labels[category] || category || '';
}

function keyRuntimeReason(key) {
  if (key.disabled_reason) return keyErrorCategoryLabel(key.last_error_category) || '不可用';
  if (key.status === 'delayed' && key.next_available_at) return `临时限流，等待至 ${formatTime(key.next_available_at)}`;
  if (key.status === 'available' && key.last_error_category) {
    const label = keyErrorCategoryLabel(key.last_error_category);
    return label ? `已恢复（最近：${label}）` : '';
  }
  if (key.last_error_category) return keyErrorCategoryLabel(key.last_error_category);
  return '';
}

function openQuotaEditor(providerId, keyIndex, current) {
  const c = current || {};
  const reqVal = c.max_requests != null ? c.max_requests : '';
  const tokVal = c.max_tokens != null ? c.max_tokens : '';
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
    </div>`;
  Dialog.show(`编辑配额 — ${providerId} #${keyIndex + 1}`, html, [
    { text: '取消', class: 'btn-secondary' },
    { text: '保存', class: 'btn-primary', action: () => submitQuota(providerId, keyIndex) }
  ]);
}

function submitQuota(providerId, keyIndex) {
  let quota;
  try {
    quota = readQuotaInputs('qf');
  } catch (err) {
    Toast.error(err.message);
    return;
  }
  fetch(`/api/keys/${encodeURIComponent(providerId)}/${keyIndex}/quota`, {
    method: 'PUT', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ quota })
  })
  .then(res => res.json().then(data => ({ ok: res.ok, data })))
  .then(({ ok, data }) => {
    if (!ok) throw new Error(data.message || '保存失败');
    setStatus(data.message || '配额已更新');

    // 同步更新 keyStates
    if (keyStates[providerId] && keyStates[providerId][keyIndex]) {
      keyStates[providerId][keyIndex].quota = data.quota;
    }

    // ✅ 同步更新 currentConfig，避免后续全局保存时覆盖
    const provider = currentConfig.providers.find(p => p.provider_id === providerId);
    if (provider && Array.isArray(provider.api_key) && provider.api_key[keyIndex]) {
      provider.api_key[keyIndex].quota = data.quota;
    }

    renderTable();
    Toast.success(data.message || '配额已更新');
  })
  .catch(err => Toast.error('保存失败：' + err.message));
}

function readQuotaInputs(prefix) {
  const reqRaw = document.getElementById(`${prefix}-max-req`).value.trim();
  const tokRaw = document.getElementById(`${prefix}-max-tok`).value.trim();
  const thrRaw = document.getElementById(`${prefix}-threshold`).value.trim();

  // ✅ 清空所有输入 → undefined（继承供应商配额）
  if (!reqRaw && !tokRaw && !thrRaw) return undefined;

  const max_requests = reqRaw ? Number(reqRaw) : null;
  const max_tokens = tokRaw ? Number(tokRaw) : null;
  if (reqRaw && (!Number.isFinite(max_requests) || max_requests <= 0)) {
    throw new Error('请求次数上限必须为正数');
  }
  if (tokRaw && (!Number.isFinite(max_tokens) || max_tokens <= 0)) {
    throw new Error('Token 总量上限必须为正数');
  }

  const quota = { max_requests, max_tokens };
  if (thrRaw) {
    const threshold = Number(thrRaw);
    if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
      throw new Error('软停阈值必须在 (0, 1] 之间');
    }
    quota.soft_stop_threshold = threshold;
  }
  return quota;
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
  setStatus('正在加载配置...');
  const res = await fetch('/api/config', { credentials: 'include' });
  if (res.status === 401) { window.location.href = '/login'; return; }
  const data = await res.json();
  currentConfig = data.config;
  renderSummary(data.summary);
  proxyAuthTokenInput.value = currentConfig.proxy_auth_token || '';
  keyMaxErrorsInput.value = currentConfig.key_max_errors || '';
  fillAntiBanConfig(currentConfig.anti_ban);
  refreshDefaultModelSelect();

  // 从 /api/config 响应中加载所有运行时状态（一次性，不需要单独调用）
  if (data.key_states) {
    keyStates = data.key_states;
  }

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
    anti_ban: readAntiBanConfig(),
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
    Toast.success(data.message || '配置已保存并生效');
  } catch (error) {
    setStatus('保存失败：' + error.message, true);
    Toast.error('保存失败：' + error.message);
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

// 用当前供应商列表同步筛选下拉框选项，保留已选中的值。
function syncModelFilterProviderOptions() {
  const ids = currentConfig.providers.map(p => p.provider_id).filter(Boolean);
  const current = modelFilter.provider;
  modelFilterProvider.innerHTML = '<option value="">全部供应商</option>'
    + ids.map(id => `<option value="${esc(id)}">${esc(id)}</option>`).join('');
  // 若原选中的供应商已不存在，重置为「全部」。
  modelFilterProvider.value = ids.includes(current) ? current : '';
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
  const isProvider = currentTab === 'providers';
  const items = isProvider ? currentConfig.providers : currentConfig.models;
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
  const quotaText = quotaSummary(p.quota);
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
    <td class="col-strategy"><div class="strategy-cell"><span class="strategy-name">${strat}</span><span class="text-dim">${esc(quotaText)}</span><span>${antiBanSummary(p)}</span></div></td>
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

function quotaSummary(quota) {
  if (!quota) return '默认配额：未配置';
  const parts = [];
  if (quota.max_requests != null) parts.push(`请求 ${quota.max_requests}`);
  if (quota.max_tokens != null) parts.push(`Token ${quota.max_tokens}`);
  if (quota.soft_stop_threshold != null) parts.push(`阈值 ${quota.soft_stop_threshold}`);
  return parts.length ? `默认配额：${parts.join(' / ')}` : '默认配额：未配置';
}

// 供应商行的防封摘要 badge：一眼看到自动禁用是否开启 + 自动恢复时长，无需进编辑弹窗。
function antiBanSummary(p) {
  const autoDisable = p.auto_disable_on_error !== false;
  if (!autoDisable) return '<span class="badge badge-off">自动禁用 关</span>';
  const recover = Number(p.auto_recover_minutes) || 0;
  return recover > 0
    ? `<span class="badge badge-info">自动恢复 ${recover} 分钟</span>`
    : '<span class="badge badge-warn">仅手动恢复</span>';
}

function renderKeyPanelHtml(providerId) {
  const keys = keyStates[providerId] || getKeyArray(currentConfig.providers.find(p => p.provider_id === providerId) || {});

  let rows = '';
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const status = k.status || (k.enabled ? 'available' : 'disabled');
    const statusLabel = keyStatusLabel(status, k);
    const enabledBadge = !k.enabled
      ? (k.auto_disabled_at
        ? `<span class="badge badge-auto-off toggle-enabled" data-type="key" data-provider="${esc(providerId)}" data-idx="${i}" title="点击启用">${statusLabel}</span>`
        : `<span class="badge badge-off toggle-enabled" data-type="key" data-provider="${esc(providerId)}" data-idx="${i}" title="点击启用">${statusLabel}</span>`)
      : (status === 'delayed'
        ? `<span class="badge badge-warn toggle-enabled" data-type="key" data-provider="${esc(providerId)}" data-idx="${i}" title="点击禁用">${statusLabel}</span>`
        : status === 'busy'
        ? `<span class="badge badge-info toggle-enabled" data-type="key" data-provider="${esc(providerId)}" data-idx="${i}" title="并发已满，活跃请求 ${k.active_requests}">${statusLabel}</span>`
        : `<span class="badge badge-on toggle-enabled" data-type="key" data-provider="${esc(providerId)}" data-idx="${i}" title="点击禁用">${statusLabel}</span>`);

    const errorBadge = k.error_count > 0
      ? `<span class="badge ${k.error_count >= 3 ? 'badge-warn' : 'badge-info'}">错误 ${k.error_count} 次</span>`
      : '<span class="text-dim">无错误</span>';

    const quotaBlock = (() => {
      if (!k.quota) return '<span class="text-dim">未配置配额</span>';
      const usage = k.usage || { requests_used: 0, tokens_used: 0 };
      const reqMax = k.quota.max_requests;
      const tokMax = k.quota.max_tokens;
      const reqPct = reqMax ? Math.min(100, Math.round(usage.requests_used / reqMax * 100)) : 0;
      const tokPct = tokMax ? Math.min(100, Math.round(usage.tokens_used / tokMax * 100)) : 0;
      const blocked = k.quota_blocked
        ? `<span class="badge health-bad" title="${esc(k.quota_reason || '配额接近上限')}">软停用</span>`
        : '';
      const reqRow = reqMax
        ? `<div class="quota-line">请求 ${usage.requests_used}/${reqMax}<div class="quota-bar"><span style="width:${reqPct}%"></span></div></div>`
        : '';
      const tokRow = tokMax
        ? `<div class="quota-line">Token ${usage.tokens_used}/${tokMax}<div class="quota-bar"><span style="width:${tokPct}%"></span></div></div>`
        : '';
      return `<div class="quota-row">${reqRow}${tokRow}${blocked}</div>`;
    })();

    let actions = `<button class="btn-icon key-action-btn" data-provider="${esc(providerId)}" data-idx="${i}" data-action="reset">重置</button>`;
    actions += `<button class="btn-icon key-quota-edit-btn" data-provider="${esc(providerId)}" data-idx="${i}">配额…</button>`;
    actions += k.quota
      ? `<button class="btn-icon key-quota-reset-btn" data-provider="${esc(providerId)}" data-idx="${i}">重置配额</button>`
      : `<span class="btn-icon-placeholder" aria-hidden="true"></span>`;
    actions += `<button class="btn-icon danger key-delete-btn" data-provider="${esc(providerId)}" data-idx="${i}">删除</button>`;
    actions = `<div class="key-action-grid">${actions}</div>`;

    const lastError = k.last_error_message
      ? `<span class="key-error-detail" title="${esc(k.last_error_message)}">${esc(k.last_error_message)} · ${formatTime(k.last_error_at)}</span>`
      : '';
    const runtimeReason = keyRuntimeReason(k);
    const runtimeInfo = runtimeReason
      ? `<span class="key-runtime-reason" title="${esc(k.last_error_message || k.disabled_reason || runtimeReason)}">${esc(runtimeReason)}</span>`
      : '<span class="text-dim">-</span>';

    const noteStr = k.note ? `<span class="key-note" title="${esc(k.note)}">${esc(k.note)}</span>` : '';

    rows += `<tr class="key-detail-row">
      <td class="key-col-index">${i + 1}</td>
      <td class="key-col-key" title="${esc(k.key)}">${maskKey(k.key)} ${noteStr}</td>
      <td class="key-col-note">
        <input class="key-note-input" data-provider="${esc(providerId)}" data-idx="${i}" value="${esc(k.note || '')}" placeholder="备注..." />
      </td>
      <td class="key-col-status">${enabledBadge}</td>
      <td class="key-col-errors">${errorBadge}${lastError ? '<br>' + lastError : ''}</td>
      <td class="key-col-runtime">${runtimeInfo}<br>${quotaBlock}</td>
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
          <th class="key-th-index">#</th>
          <th class="key-th-key">Key</th>
          <th class="key-th-note">备注</th>
          <th class="key-th-status">状态</th>
          <th class="key-th-errors">错误</th>
          <th class="key-th-runtime">运行状态</th>
          <th class="key-th-time">禁用时间</th>
          <th class="key-th-actions col-actions">操作</th>
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
    .catch(err => Toast.error('备注更新失败：' + err.message));
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
      Toast.info('请输入至少一个 Key 值');
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
      Toast.success(data.message || `${keys.length} 个 Key 已添加`);
      input.value = '';
      renderKeyPanel(providerId);
      loadConfig();
    })
    .catch(err => Toast.error('添加失败：' + err.message));
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
        Toast.success(data.message || `${providerId} 所有 Key 已重置`);
        renderKeyPanel(providerId);
        loadConfig();
      })
      .catch(err => Toast.error('重置失败：' + err.message));
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
        Toast.success(`Key 已删除`);
        renderKeyPanel(providerId);
        loadConfig();
      })
      .catch(err => Toast.error('删除失败：' + err.message));
    }, '确认删除', '取消', 'btn-danger');
    return;
  }

  if (target.classList.contains('key-quota-edit-btn')) {
    const providerId = target.dataset.provider;
    const keyIndex = parseInt(target.dataset.idx);
    const keys = keyStates[providerId] || [];
    const current = keys[keyIndex]?.quota || null;
    openQuotaEditor(providerId, keyIndex, current);
    return;
  }

  if (target.classList.contains('key-quota-reset-btn')) {
    const providerId = target.dataset.provider;
    const keyIndex = parseInt(target.dataset.idx);
    Dialog.confirm('确认重置配额', `确定要清零 ${providerId} 第 ${keyIndex + 1} 个 Key 的本地配额计数吗？`, () => {
      fetch(`/api/keys/${encodeURIComponent(providerId)}/${keyIndex}/quota/reset`, {
        method: 'POST',
        credentials: 'include'
      })
      .then(res => res.json().then(data => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        if (!ok) throw new Error(data.message || '重置配额失败');
        setStatus(data.message || '配额计数已清零');
        Toast.success(data.message || '配额计数已清零');

        // 直接更新本地 keyStates 中的 usage 数据
        if (keyStates[providerId] && keyStates[providerId][keyIndex]) {
          if (keyStates[providerId][keyIndex].usage) {
            keyStates[providerId][keyIndex].usage.requests_used = 0;
            keyStates[providerId][keyIndex].usage.tokens_used = 0;
          }
          keyStates[providerId][keyIndex].quota_blocked = false;
          keyStates[providerId][keyIndex].quota_reason = null;
        }

        renderTable();
      })
      .catch(err => Toast.error('重置配额失败：' + err.message));
    }, '确认重置', '取消', 'btn-warning');
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
        if (existing.anti_ban) item.anti_ban = existing.anti_ban;
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
    Toast.error(e.message);
  }
}

function providerFormHtml(item) {
  const p = item || {};
  const keys = getKeyArray(p);
  const quota = p.quota || {};
  const quotaReqVal = quota.max_requests != null ? quota.max_requests : '';
  const quotaTokVal = quota.max_tokens != null ? quota.max_tokens : '';
  const quotaThrVal = quota.soft_stop_threshold != null ? quota.soft_stop_threshold : '';
  const keyDisplay = keys.length > 0
    ? `<div class="key-info-box"><div class="form-label-row"><span class="form-label">当前 API Keys</span><i class="info-tip" data-tip="在供应商列表的&quot;Keys&quot;面板中管理各 Key 的启用/禁用/重置。新增 Key 请在下方输入。">i</i></div><div class="key-list-preview">${keys.map((k, i) =>
        `<div class="key-list-item ${k.enabled ? '' : 'key-disabled'}">${i + 1}. ${maskKey(k.key)} <span class="badge ${k.enabled ? 'badge-on' : 'badge-off'}">${k.enabled ? '启用' : '禁用'}</span> <span class="text-dim">错误: ${k.error_count || 0}</span></div>`
      ).join('')}</div></div>`
    : '';

  return `
    <div class="form-grid">
      <div class="form-group">
        <div class="form-label-row"><span class="form-label">供应商 ID *</span><span class="field-key">provider_id</span></div>
        <input id="mf-provider_id" type="text" value="${esc(p.provider_id)}" placeholder="例如：nvidia2" />
      </div>
      <div class="form-group">
        <div class="form-label-row"><span class="form-label">说明</span><span class="field-key">description</span></div>
        <input id="mf-description" type="text" value="${esc(p.description)}" placeholder="例如：第二个 NVIDIA 入口" />
      </div>
      <div class="form-group">
        <div class="form-label-row"><span class="form-label">供应商类型 *</span><span class="field-key">provider_type</span></div>
        <select id="mf-provider_type">
          <option value="openai_compatible" ${(p.provider_type||'openai_compatible')==='openai_compatible'?'selected':''}>OpenAI 兼容（协议转换 / 透传）</option>
          <option value="anthropic" ${p.provider_type==='anthropic'?'selected':''}>Anthropic 兼容（透传）</option>
        </select>
      </div>
      <div class="form-group">
        <div class="form-label-row"><span class="form-label">上游接入地址 *</span><span class="field-key">base_url</span></div>
        <input id="mf-base_url" type="text" value="${esc(p.base_url)}" placeholder="https://integrate.api.nvidia.com/v1" />
      </div>
      <div class="form-group">
        <div class="form-label-row"><span class="form-label">环境变量名</span><span class="field-key">api_key_env</span></div>
        <input id="mf-api_key_env" type="text" value="${esc(p.api_key_env)}" placeholder="多个变量名用逗号分隔" />
      </div>
      <div class="form-group">
        <div class="form-label-row"><span class="form-label">新增 API Key（多个用逗号分隔）</span><span class="field-key">api_key</span></div>
        <input id="mf-api_key" type="password" value="" placeholder="留空则保留现有 Key 不变" />
      </div>
      <div class="form-group">
        <div class="form-label-row"><span class="form-label">Key 切换策略</span><span class="field-key">key_rotation_strategy</span></div>
        <select id="mf-key_rotation_strategy">
          <option value="round_robin" ${(p.key_rotation_strategy||'round_robin')==='round_robin'?'selected':''}>轮询（Round-Robin）</option>
          <option value="on_429" ${p.key_rotation_strategy==='on_429'?'selected':''}>遇 429 自动切换</option>
        </select>
      </div>
      <div class="field-fieldset">
        <div class="field-fieldset-title">错误自动禁用 / 恢复</div>
        <div class="form-group">
          <label class="checkbox-wrapper">
            <input id="mf-auto_disable_on_error" type="checkbox" ${p.auto_disable_on_error!==false?'checked':''} />
            <span class="checkbox-label">错误累计自动禁用 Key <span class="field-key">auto_disable_on_error</span><i class="info-tip" data-tip="累计错误达到阈值（顶部全局配置「Key 自动禁用阈值 key_max_errors」，默认 5）后禁用该 Key；429 限流同样计入。调用成功后错误计数自动清零。部分不稳定供应商可关闭此功能。">i</i></span>
          </label>
        </div>
        <div class="form-group" style="margin-bottom:0">
          <div class="form-label-row"><span class="form-label">自动禁用后自动恢复</span><span class="field-key">auto_recover_minutes</span><span class="form-label-unit">分钟</span><i class="info-tip" data-tip="自动禁用的 Key 经过指定分钟数后会按时重新启用并清零错误计数，无需等待新请求。0 或留空表示只能手动恢复。手动禁用的 Key 不受影响。">i</i></div>
          <input id="mf-auto_recover_minutes" type="number" min="0" value="${p.auto_recover_minutes||0}" placeholder="0 = 不自动恢复" />
        </div>
      </div>
      <div class="form-group">
        <div class="form-label-row"><span class="form-label">请求超时</span><span class="field-key">timeout_seconds</span><span class="form-label-unit">秒</span></div>
        <input id="mf-timeout_seconds" type="number" min="1" value="${p.timeout_seconds||300}" />
      </div>
      <div class="form-group">
        <div class="form-label-row"><span class="form-label">流式空闲超时</span><span class="field-key">stream_idle_timeout_seconds</span><span class="form-label-unit">秒</span></div>
        <input id="mf-stream_idle_timeout_seconds" type="number" min="1" value="${p.stream_idle_timeout_seconds||120}" />
      </div>
      <div class="form-group">
        <div class="form-label-row"><span class="form-label">默认请求配额</span><span class="field-key">quota.max_requests</span></div>
        <input id="mfq-max-req" type="number" min="1" value="${esc(quotaReqVal)}" placeholder="留空 = 不限" />
      </div>
      <div class="form-group">
        <div class="form-label-row"><span class="form-label">默认 Token 配额</span><span class="field-key">quota.max_tokens</span></div>
        <input id="mfq-max-tok" type="number" min="1" value="${esc(quotaTokVal)}" placeholder="留空 = 不限" />
      </div>
      <div class="form-group">
        <div class="form-label-row"><span class="form-label">默认软停阈值</span><span class="field-key">quota.soft_stop_threshold</span><i class="info-tip" data-tip="供应商配额会作为所有 Key 的默认值；单个 Key 设置了 quota 字段时优先使用 Key 自己的配额。软停阈值表示用量达到该比例（0~1）后停止该供应商。">i</i></div>
        <input id="mfq-threshold" type="number" min="0" max="1" step="0.01" value="${esc(quotaThrVal)}" placeholder="0.95" />
      </div>
    </div>
    ${keyDisplay}
    <div class="form-group">
      <label class="checkbox-wrapper">
        <input id="mf-enabled" type="checkbox" ${p.enabled!==false?'checked':''} />
        <span class="checkbox-label">启用该供应商 <span class="field-key">enabled</span></span>
      </label>
    </div>
    <div class="form-group">
      <div class="form-label-row"><span class="form-label">自定义请求头（JSON 对象，可选）</span><span class="field-key">headers</span></div>
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
        <div class="form-label-row"><span class="form-label">客户端模型名 *</span><span class="field-key">client_model</span></div>
        <input id="mf-client_model" type="text" value="${esc(m.client_model)}" placeholder="例如：claude-sonnet-4-5" />
      </div>
      <div class="form-group">
        <div class="form-label-row"><span class="form-label">绑定供应商 *</span><span class="field-key">provider_id</span></div>
        <select id="mf-provider_id">
          <option value="">请选择供应商</option>
          ${providerOpts}
        </select>
      </div>
      <div class="form-group">
        <div class="form-label-row"><span class="form-label">上游模型名 *</span><span class="field-key">upstream_model</span></div>
        <input id="mf-upstream_model" type="text" value="${esc(m.upstream_model)}" placeholder="例如：meta/llama-3.1-70b-instruct" />
      </div>
      <div class="form-group">
        <div class="form-label-row"><span class="form-label">说明</span><span class="field-key">description</span></div>
        <input id="mf-description" type="text" value="${esc(m.description)}" placeholder="例如：给 Claude Code 使用的映射" />
      </div>
    </div>
    <div class="form-group">
      <label class="checkbox-wrapper">
        <input id="mf-enabled" type="checkbox" ${m.enabled!==false?'checked':''} />
        <span class="checkbox-label">启用该模型映射 <span class="field-key">enabled</span></span>
      </label>
    </div>
    <div class="form-group">
      <div class="form-label-row"><span class="form-label">额外请求体（JSON 对象，可选）</span><span class="field-key">extra_body</span></div>
      <textarea id="mf-extra_body" placeholder='{"top_k":20}'>${JSON.stringify(m.extra_body||{},null,2)}</textarea>
    </div>`;
}

function collectProviderForm() {
  const provider_id = $('#mf-provider_id').value.trim();
  const base_url = $('#mf-base_url').value.trim();
  if (!provider_id) throw new Error('供应商 ID 不能为空');
  if (!base_url) throw new Error('上游接入地址 不能为空');

  const newKeyInput = $('#mf-api_key').value.trim();
  let apiKey = null;
  if (newKeyInput) {
    apiKey = newKeyInput.split(',').map(k => k.trim()).filter(Boolean).map(k => ({
      key: k, enabled: true, error_count: 0, disabled_at: null,
      last_error_at: null, last_error_message: null, auto_disabled_at: null
    }));
    if (apiKey.length === 0) apiKey = null;
  }

  const quota = readQuotaInputs('mfq');

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
    auto_recover_minutes: Number($('#mf-auto_recover_minutes').value || 0),
    quota,
    headers: parseJsonSafe($('#mf-headers').value, {}),
    description: $('#mf-description').value.trim(),
  };
}

function collectModelForm() {
  const client_model = $('#mf-client_model').value.trim();
  const provider_id = $('#mf-provider_id').value.trim();
  const upstream_model = $('#mf-upstream_model').value.trim();
  if (!client_model) throw new Error('客户端模型名 不能为空');
  if (!provider_id) throw new Error('绑定供应商 不能为空');
  if (!upstream_model) throw new Error('上游模型名 不能为空');
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
const themeToggleBtn = document.getElementById('themeToggleBtn');
if (themeToggleBtn) {
  themeToggleBtn.addEventListener('click', () => Theme.toggle());
}
ensureSession().then(loadConfig).catch(e => setStatus(e.message, true));
