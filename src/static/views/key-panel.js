import { escapeHtml as esc } from '../admin-ui.js';

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

export function renderKeyPanelHtml(providerId, keys) {
  let rows = '';
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const isConfigKey = k.source !== 'environment';
    const status = k.status || (k.enabled ? 'available' : 'disabled');
    const statusLabel = keyStatusLabel(status, k);
    const enabledBadge = !k.enabled
      ? (k.auto_disabled_at
        ? `<span class="badge badge-auto-off toggle-enabled" data-type="key" data-provider="${esc(providerId)}" data-key-id="${esc(k.id)}" title="点击启用">${statusLabel}</span>`
        : `<span class="badge badge-off toggle-enabled" data-type="key" data-provider="${esc(providerId)}" data-key-id="${esc(k.id)}" title="点击启用">${statusLabel}</span>`)
      : (status === 'delayed'
        ? `<span class="badge badge-warn toggle-enabled" data-type="key" data-provider="${esc(providerId)}" data-key-id="${esc(k.id)}" title="点击禁用">${statusLabel}</span>`
        : status === 'busy'
        ? `<span class="badge badge-info toggle-enabled" data-type="key" data-provider="${esc(providerId)}" data-key-id="${esc(k.id)}" title="并发已满，活跃请求 ${k.active_requests}">${statusLabel}</span>`
        : `<span class="badge badge-on toggle-enabled" data-type="key" data-provider="${esc(providerId)}" data-key-id="${esc(k.id)}" title="点击禁用">${statusLabel}</span>`);

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

    let actions = `<button class="btn-icon key-action-btn" data-provider="${esc(providerId)}" data-key-id="${esc(k.id)}" data-action="reset">重置</button>`;
    actions += isConfigKey
      ? `<button class="btn-icon key-quota-edit-btn" data-provider="${esc(providerId)}" data-key-id="${esc(k.id)}" data-display-index="${i}">配额…</button>`
      : `<span class="btn-icon-placeholder" aria-hidden="true"></span>`;
    actions += isConfigKey && k.quota
      ? `<button class="btn-icon key-quota-reset-btn" data-provider="${esc(providerId)}" data-key-id="${esc(k.id)}" data-display-index="${i}">重置配额</button>`
      : `<span class="btn-icon-placeholder" aria-hidden="true"></span>`;
    actions += isConfigKey
      ? `<button class="btn-icon danger key-delete-btn" data-provider="${esc(providerId)}" data-key-id="${esc(k.id)}" data-display-index="${i}">删除</button>`
      : `<span class="btn-icon-placeholder" aria-hidden="true"></span>`;
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
      <td class="key-col-key">${esc(k.key_mask || '********')} ${isConfigKey ? '' : '<span class="badge badge-info">环境变量</span>'} ${noteStr}</td>
      <td class="key-col-note">
        <input class="key-note-input" data-provider="${esc(providerId)}" data-key-id="${esc(k.id)}" value="${esc(k.note || '')}" placeholder="备注..." ${isConfigKey ? '' : 'disabled'} />
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
      <div class="key-table-scroll"><table class="key-detail-table">
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
      </table></div>`}
    </div>
  </td></tr>`;
}
