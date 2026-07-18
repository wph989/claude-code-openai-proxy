import { escapeHtml as esc } from '../admin-ui.js';
import { parseJsonSafe } from './shared.js';

const $ = (selector) => document.querySelector(selector);

export function modelFormHtml(item, providers) {
  const m = item || {};
  const providerOpts = providers.map(p =>
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
      <textarea id="mf-extra_body" placeholder='{"top_k":20}'>${esc(JSON.stringify(m.extra_body||{},null,2))}</textarea>
    </div>`;
}
export function collectModelForm() {
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
