import { escapeHtml as esc } from '../admin-ui.js';

export function renderProviderRow(provider, index, expandedProviderId, runtimeSettings) {
  const strategy = provider.key_rotation_strategy === 'on_429' ? '遇429切换' : '轮询';
  const quotaText = quotaSummary(provider.quota);
  const typeLabel = provider.provider_type === 'anthropic' ? 'Anthropic' : 'OpenAI';
  const badge = provider.enabled !== false
    ? `<span class="badge badge-on toggle-enabled" data-idx="${index}" data-type="provider" title="点击停用">启用</span>`
    : `<span class="badge badge-off toggle-enabled" data-idx="${index}" data-type="provider" title="点击启用">停用</span>`;
  const keys = Array.isArray(provider.api_key) ? provider.api_key : [];
  const isExpanded = expandedProviderId === provider.provider_id;
  return `<tr>
    <td class="col-id">${esc(provider.provider_id)}</td>
    <td>${typeLabel}</td>
    <td class="col-url" title="${esc(provider.base_url)}">${esc(provider.base_url)}</td>
    <td class="col-strategy"><div class="strategy-cell"><span class="strategy-name">${strategy}</span><span class="text-dim">${esc(quotaText)}</span><span>${antiBanSummary(provider, runtimeSettings)} ${circuitSummary(provider)}</span></div></td>
    <td>${badge}</td>
    <td class="col-actions">
      <button class="btn-icon keys-btn" data-provider="${esc(provider.provider_id)}" title="管理 API Keys">${isExpanded ? '收起 Keys' : 'Keys'} (${keys.length})</button>
      <button class="btn-icon provider-test-btn" data-provider="${esc(provider.provider_id)}" title="仅请求 GET /models，不调用生成模型">测试</button>
      <button class="btn-icon edit-btn" data-idx="${index}">编辑</button>
      <button class="btn-icon danger delete-btn" data-idx="${index}">删除</button>
    </td>
  </tr>`;
}

export function renderModelRow(model, index) {
  const badge = model.enabled !== false
    ? `<span class="badge badge-on toggle-enabled" data-idx="${index}" data-type="model" title="点击停用">启用</span>`
    : `<span class="badge badge-off toggle-enabled" data-idx="${index}" data-type="model" title="点击启用">停用</span>`;
  return `<tr>
    <td class="col-model">${esc(model.client_model)}</td>
    <td>${esc(model.provider_id)}</td>
    <td>${esc(model.upstream_model)}</td>
    <td class="col-number">${esc(model.priority ?? 0)}</td>
    <td class="col-number">${esc(model.weight ?? 1)}</td>
    <td>${badge}</td>
    <td class="col-actions">
      <button class="btn-icon edit-btn" data-idx="${index}">编辑</button>
      <button class="btn-icon danger delete-btn" data-idx="${index}">删除</button>
    </td>
  </tr>`;
}

function quotaSummary(quota) {
  if (!quota) return '默认配额：未配置';
  const parts = [];
  if (quota.max_requests != null) parts.push(`请求 ${quota.max_requests}`);
  if (quota.max_tokens != null) parts.push(`Token ${quota.max_tokens}`);
  if (quota.max_cost_usd != null) parts.push(`费用 $${quota.max_cost_usd}`);
  if (quota.soft_stop_threshold != null) parts.push(`阈值 ${quota.soft_stop_threshold}`);
  return parts.length ? `默认配额：${parts.join(' / ')}` : '默认配额：未配置';
}

function antiBanSummary(provider, runtimeSettings) {
  if (runtimeSettings.key_auto_disable === false) {
    return '<span class="badge badge-off">全局自动禁用 关</span>';
  }
  if (provider.auto_disable_on_error === false) {
    return '<span class="badge badge-off">自动禁用 关</span>';
  }
  const recover = Number(provider.auto_recover_minutes) || 0;
  return recover > 0
    ? `<span class="badge badge-info">自动恢复 ${recover} 分钟</span>`
    : '<span class="badge badge-warn">仅手动恢复</span>';
}

function circuitSummary(provider) {
  if (provider.circuit_breaker === null) return '<span class="badge badge-off">熔断 关</span>';
  if (provider.circuit_status?.state === 'open') return '<span class="badge badge-off">熔断中</span>';
  if (provider.circuit_status?.state === 'half_open') return '<span class="badge badge-warn">半开探测</span>';
  const threshold = provider.circuit_breaker?.failure_threshold ?? 3;
  const recovery = provider.circuit_breaker?.recovery_seconds ?? 30;
  return `<span class="badge badge-info">熔断 ${esc(threshold)}次 / ${esc(recovery)}秒</span>`;
}
