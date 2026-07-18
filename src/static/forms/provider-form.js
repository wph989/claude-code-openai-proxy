import { escapeHtml as esc } from '../admin-ui.js';
import { parseJsonSafe, readQuotaInputs } from './shared.js';

const $ = (selector) => document.querySelector(selector);

function getKeyArray(provider) {
  if (!provider?.api_key) return [];
  if (Array.isArray(provider.api_key)) return provider.api_key;
  if (typeof provider.api_key === 'string') {
    return provider.api_key.split(',').map((key) => key.trim()).filter(Boolean).map((key) => ({
      key,
      enabled: true,
      error_count: 0,
    }));
  }
  return [];
}
export function providerFormHtml(item) {
  const p = item || {};
  const keys = getKeyArray(p);
  const quota = p.quota || {};
  const quotaReqVal = quota.max_requests != null ? quota.max_requests : '';
  const quotaTokVal = quota.max_tokens != null ? quota.max_tokens : '';
  const quotaCostVal = quota.max_cost_usd != null ? quota.max_cost_usd : '';
  const quotaInputCostVal = quota.input_cost_per_million != null ? quota.input_cost_per_million : '';
  const quotaOutputCostVal = quota.output_cost_per_million != null ? quota.output_cost_per_million : '';
  const quotaThrVal = quota.soft_stop_threshold != null ? quota.soft_stop_threshold : '';
  const circuitBreakerEnabled = p.circuit_breaker !== null;
  const circuitBreaker = p.circuit_breaker || {};
  const failureThreshold = circuitBreaker.failure_threshold ?? 3;
  const recoverySeconds = circuitBreaker.recovery_seconds ?? 30;
  const keyDisplay = keys.length > 0
    ? `<div class="key-info-box"><div class="form-label-row"><span class="form-label">当前 API Keys</span><i class="info-tip" data-tip="在供应商列表的&quot;Keys&quot;面板中管理各 Key 的启用/禁用/重置。新增 Key 请在下方输入。">i</i></div><div class="key-list-preview">${keys.map((k, i) =>
        `<div class="key-list-item ${k.enabled ? '' : 'key-disabled'}">${i + 1}. ${esc(k.key_mask || '********')} <span class="badge ${k.enabled ? 'badge-on' : 'badge-off'}">${k.enabled ? '启用' : '禁用'}</span> <span class="text-dim">错误: ${k.error_count || 0}</span></div>`
      ).join('')}</div></div>`
    : '';

  return `
    <div class="form-grid">
      <div class="form-group">
        <div class="form-label-row"><span class="form-label">供应商 ID *</span><span class="field-key">provider_id</span></div>
        <input id="mf-provider_id" type="text" value="${esc(p.provider_id)}" placeholder="例如：nvidia2" ${p.provider_id ? 'readonly' : ''} />
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
      <div class="field-fieldset">
        <div class="field-fieldset-title">Provider 熔断</div>
        <div class="form-group">
          <label class="checkbox-wrapper">
            <input id="mf-circuit_breaker_enabled" type="checkbox" ${circuitBreakerEnabled?'checked':''} />
            <span class="checkbox-label">启用链路熔断 <span class="field-key">circuit_breaker</span><i class="info-tip" data-tip="只统计网络异常和 5xx。达到阈值后暂停选择该 Provider，冷却结束只放行一个半开探测；429、鉴权和请求大小错误不会打开熔断。">i</i></span>
          </label>
        </div>
        <div class="form-grid form-grid-compact">
          <div class="form-group" style="margin-bottom:0">
            <div class="form-label-row"><span class="form-label">连续失败阈值</span><span class="field-key">failure_threshold</span></div>
            <input id="mf-circuit_failure_threshold" type="number" min="1" max="100" step="1" value="${esc(failureThreshold)}" />
          </div>
          <div class="form-group" style="margin-bottom:0">
            <div class="form-label-row"><span class="form-label">恢复冷却</span><span class="field-key">recovery_seconds</span><span class="form-label-unit">秒</span></div>
            <input id="mf-circuit_recovery_seconds" type="number" min="1" max="3600" step="1" value="${esc(recoverySeconds)}" />
          </div>
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
        <div class="form-label-row"><span class="form-label">默认费用上限</span><span class="field-key">quota.max_cost_usd</span><span class="form-label-unit">USD</span></div>
        <input id="mfq-max-cost" type="number" min="0" step="0.000001" value="${esc(quotaCostVal)}" placeholder="留空 = 不限" />
      </div>
      <div class="form-group">
        <div class="form-label-row"><span class="form-label">输入 Token 单价</span><span class="field-key">quota.input_cost_per_million</span><span class="form-label-unit">USD / 1M</span></div>
        <input id="mfq-input-cost" type="number" min="0" step="0.000001" value="${esc(quotaInputCostVal)}" placeholder="例如 3" />
      </div>
      <div class="form-group">
        <div class="form-label-row"><span class="form-label">输出 Token 单价</span><span class="field-key">quota.output_cost_per_million</span><span class="form-label-unit">USD / 1M</span></div>
        <input id="mfq-output-cost" type="number" min="0" step="0.000001" value="${esc(quotaOutputCostVal)}" placeholder="例如 15" />
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
      <textarea id="mf-headers" placeholder='{"api-version":"2024-xx"}'>${esc(JSON.stringify(p.headers||{},null,2))}</textarea>
    </div>`;
}
export function collectProviderForm() {
  const provider_id = $('#mf-provider_id').value.trim();
  const base_url = $('#mf-base_url').value.trim();
  if (!provider_id) throw new Error('供应商 ID 不能为空');
  if (!base_url) throw new Error('上游接入地址 不能为空');

  const quota = readQuotaInputs('mfq');
  const circuitBreakerEnabled = $('#mf-circuit_breaker_enabled').checked;
  const failureThreshold = Number($('#mf-circuit_failure_threshold').value);
  const recoverySeconds = Number($('#mf-circuit_recovery_seconds').value);
  if (circuitBreakerEnabled && (!Number.isInteger(failureThreshold) || failureThreshold < 1 || failureThreshold > 100)) {
    throw new Error('熔断连续失败阈值必须是 1~100 的整数');
  }
  if (circuitBreakerEnabled && (!Number.isInteger(recoverySeconds) || recoverySeconds < 1 || recoverySeconds > 3600)) {
    throw new Error('熔断恢复冷却必须是 1~3600 秒的整数');
  }

  return {
    provider_id,
    provider_type: $('#mf-provider_type').value || 'openai_compatible',
    base_url,
    api_key: null,
    api_key_env: $('#mf-api_key_env').value.trim() || null,
    key_rotation_strategy: $('#mf-key_rotation_strategy').value || 'round_robin',
    timeout_seconds: Number($('#mf-timeout_seconds').value || 300),
    stream_idle_timeout_seconds: Number($('#mf-stream_idle_timeout_seconds').value || 120),
    enabled: $('#mf-enabled').checked,
    auto_disable_on_error: $('#mf-auto_disable_on_error').checked,
    auto_recover_minutes: Number($('#mf-auto_recover_minutes').value || 0),
    circuit_breaker: circuitBreakerEnabled ? {
      failure_threshold: failureThreshold,
      recovery_seconds: recoverySeconds,
    } : null,
    quota,
    headers: parseJsonSafe($('#mf-headers').value, {}),
    description: $('#mf-description').value.trim(),
  };
}
