import { escapeHtml as esc } from '../admin-ui.js';

export function renderSummary(container, summary) {
  const items = [
    ['供应商总数', summary.provider_count || 0],
    ['模型总数', summary.model_count || 0],
    ['启用供应商', summary.enabled_provider_count || 0],
    ['启用模型', summary.enabled_model_count || 0],
  ];
  container.innerHTML = items.map(([label, value], index) =>
    `<div class="stat-card" style="animation-delay:${index * 50}ms"><div class="stat-label">${label}</div><div class="stat-value">${value}</div></div>`
  ).join('');
}

export function renderChangePreview(container, data) {
  if (!data.has_changes) {
    container.textContent = '当前没有未保存的配置变更。';
    return;
  }
  const scopeLabels = { global: '全局', provider: '供应商', route: '模型路由' };
  const actionLabels = { add: '新增', update: '修改', delete: '删除' };
  container.innerHTML = `<ul class="change-preview-list">${data.changes.map((change) => {
    const fields = change.fields?.length ? `：${change.fields.join('、')}` : '';
    return `<li>${esc(scopeLabels[change.scope] || change.scope)} · ${esc(actionLabels[change.action] || change.action)} ${esc(change.target)}${esc(fields)}</li>`;
  }).join('')}</ul>`;
}
