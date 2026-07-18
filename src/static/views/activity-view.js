import { escapeHtml as esc } from '../admin-ui.js';

const TYPE_META = {
  'config.changed': { label: '配置', className: 'config' },
  'key.changed': { label: 'Key', className: 'key' },
  'quota.changed': { label: '配额', className: 'quota' },
  'request.completed': { label: '请求', className: 'request' },
  'provider.tested': { label: '连接测试', className: 'provider' },
};

export function renderActivityView(events, options = {}) {
  const filter = options.filter || 'all';
  const visible = filter === 'all' ? events : events.filter(event => event.type === filter);
  const connectionLabel = options.connected ? '实时连接' : '正在重连';
  const connectionClass = options.connected ? 'connected' : 'disconnected';
  const rows = visible.length > 0
    ? visible.map(renderActivityRow).join('')
    : '<tr><td colspan="4"><div class="empty-state"><p>暂无活动记录</p></div></td></tr>';

  return `
    <section class="activity-view" aria-labelledby="activityTitle">
      <div class="activity-toolbar">
        <div>
          <h2 id="activityTitle" class="section-subtitle">活动日志</h2>
          <span class="activity-connection ${connectionClass}"><span aria-hidden="true"></span>${connectionLabel}</span>
        </div>
        <div class="activity-actions">
          <label class="sr-only" for="activityFilter">活动类型</label>
          <select id="activityFilter">
            ${filterOption('all', '全部类型', filter)}
            ${filterOption('request.completed', '请求', filter)}
            ${filterOption('config.changed', '配置', filter)}
            ${filterOption('key.changed', 'Key', filter)}
            ${filterOption('quota.changed', '配额', filter)}
            ${filterOption('provider.tested', '连接测试', filter)}
          </select>
          <button class="btn btn-small" id="clearActivityBtn" type="button">清空</button>
        </div>
      </div>
      <div class="activity-table-wrap">
        <table class="data-table activity-table">
          <thead><tr><th>时间</th><th>类型</th><th>对象</th><th>摘要</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>`;
}

function renderActivityRow(event) {
  const meta = TYPE_META[event.type] || { label: event.type, className: 'unknown' };
  return `<tr>
    <td class="activity-time">${esc(formatTime(event.timestamp))}</td>
    <td><span class="activity-type ${esc(meta.className)}">${esc(meta.label)}</span></td>
    <td class="activity-target">${esc(formatTarget(event))}</td>
    <td class="activity-detail">${esc(formatDetail(event))}</td>
  </tr>`;
}

function formatTarget(event) {
  const data = event.data || {};
  if (event.type === 'request.completed') return `${data.method || ''} ${data.route || ''}`.trim();
  if (data.key_id) return `${data.provider_id || '-'} / ${data.key_id}`;
  return data.provider_id || data.route_id || data.scope || '-';
}

function formatDetail(event) {
  const data = event.data || {};
  if (event.type === 'request.completed') {
    return `HTTP ${data.status_code ?? '-'} · ${data.duration_ms ?? 0} ms · TTFB ${data.ttfb_ms ?? 0} ms`;
  }
  if (event.type === 'quota.changed') {
    return `请求 ${data.requests_used ?? 0} · Token ${data.tokens_used ?? 0}${data.blocked ? ' · 已阻断' : ''}`;
  }
  if (event.type === 'key.changed') {
    if (data.action === 'runtime_state') {
      return `${data.enabled ? '可用' : '停用'} · 错误 ${data.error_count ?? 0}${data.auto_disabled ? ' · 自动停用' : ''}`;
    }
    return `${actionLabel(data.action)}${data.count ? ` · ${data.count} 个` : ''}`;
  }
  if (event.type === 'provider.tested') {
    return `${data.ok ? '连接成功' : '连接失败'} · ${data.latency_ms ?? 0} ms${data.status_code ? ` · HTTP ${data.status_code}` : ''}`;
  }
  return `${actionLabel(data.action)}${data.revision ? ` · revision ${data.revision}` : ''}`;
}

function actionLabel(action) {
  const labels = {
    updated: '已更新', created: '已创建', deleted: '已删除', rotated: '已轮换', removed: '已移除',
    added: '已添加', exported: '已导出', reset_all: '已全部重置', note_updated: '备注已更新',
  };
  return labels[action] || String(action || '状态变化');
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || '-');
  return date.toLocaleTimeString('zh-CN', { hour12: false });
}

function filterOption(value, label, selected) {
  return `<option value="${value}"${selected === value ? ' selected' : ''}>${label}</option>`;
}
