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

export function renderConfigHistory(container, entries) {
  if (!entries.length) {
    container.innerHTML = '<div class="empty-state">暂无配置历史</div>';
    return;
  }
  container.innerHTML = `<div class="table-scroll history-table-wrap"><table class="data-table history-table">
    <thead><tr><th>Revision</th><th>保存时间</th><th>资源</th><th>回滚影响</th><th class="col-actions">操作</th></tr></thead>
    <tbody>${entries.map((entry) => {
      const summary = entry.summary || {};
      const changes = (entry.rollback_changes || []).slice(0, 3).map((change) => {
        const fields = change.fields?.length ? ` (${change.fields.join('、')})` : '';
        return `${change.target}${fields}`;
      });
      const more = (entry.rollback_changes || []).length > 3
        ? ` 等 ${entry.rollback_changes.length} 项`
        : '';
      const impact = entry.current
        ? '当前版本'
        : changes.length ? `${changes.join('；')}${more}` : '配置内容一致';
      return `<tr>
        <td class="col-number">${esc(entry.revision)}</td>
        <td>${esc(formatHistoryTime(entry.created_at))}</td>
        <td>${esc(summary.provider_count || 0)} 个供应商 / ${esc(summary.model_count || 0)} 条路由</td>
        <td class="history-impact" title="${esc(impact)}">${esc(impact)}</td>
        <td class="col-actions"><button class="btn btn-small history-rollback-btn" data-revision="${esc(entry.revision)}" ${entry.current ? 'disabled' : ''}>回滚</button></td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>`;
}

function formatHistoryTime(value) {
  const date = new Date(Number(value));
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false }) : '-';
}
