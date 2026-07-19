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

export function renderOverviewInsights(container, events, selectedMetric = 'tokens') {
  const metric = ['tokens', 'cost', 'requests'].includes(selectedMetric) ? selectedMetric : 'tokens';
  const snapshot = buildOverviewSnapshot(events);
  const metricMeta = {
    tokens: { label: 'Token', value: formatCompact(snapshot.tokens), suffix: '累计处理量' },
    cost: { label: '费用', value: formatMoney(snapshot.cost), suffix: '累计估算费用' },
    requests: { label: '请求', value: formatInteger(snapshot.requests), suffix: '近期请求数' },
  }[metric];

  container.innerHTML = `
    <div class="overview-grid">
      <section class="overview-panel overview-usage" aria-labelledby="usageTrendTitle">
        <div class="overview-panel-header">
          <div>
            <h3 id="usageTrendTitle">模型调用消耗</h3>
            <p>根据当前服务进程收到的实时用量事件统计。</p>
          </div>
          <div class="overview-metrics" role="group" aria-label="消耗指标">
            ${renderMetricButton('tokens', 'Token', metric)}
            ${renderMetricButton('cost', '费用', metric)}
            ${renderMetricButton('requests', '请求', metric)}
          </div>
        </div>
        <div class="overview-total"><strong>${esc(metricMeta.value)}</strong><span>${esc(metricMeta.suffix)}</span></div>
        ${renderUsageChart(snapshot.points, metric)}
        <div class="overview-legend"><span class="overview-legend-line"></span>${esc(metricMeta.label)}趋势 · 最近 ${snapshot.points.length} 天</div>
      </section>

      <section class="overview-panel overview-announcements" aria-labelledby="announcementTitle">
        <div class="overview-panel-header">
          <div><h3 id="announcementTitle">更新公告</h3><p>当前版本的重点变更。</p></div>
          <span class="version-badge">v0.4.2</span>
        </div>
        <div class="announcement-list">
          <article class="announcement-item"><time>2026-07-19</time><div><strong>概览页功能更新</strong><p>新增模型调用消耗曲线、近期请求和版本公告；优化顶部状态提示与 Tab 导航布局。</p></div></article>
        </div>
      </section>
    </div>
    <section class="overview-panel overview-recent" aria-labelledby="recentRequestsTitle">
      <div class="overview-panel-header"><div><h3 id="recentRequestsTitle">近期请求</h3><p>实时活动流中的最近代理请求。</p></div><span class="overview-summary-note">成功 ${snapshot.successes} · 异常 ${snapshot.failures}</span></div>
      ${renderRecentRequests(snapshot.recentRequests)}
    </section>`;
}

function renderMetricButton(value, label, selected) {
  return `<button class="overview-metric-btn${value === selected ? ' active' : ''}" type="button" data-overview-metric="${value}" aria-pressed="${value === selected ? 'true' : 'false'}">${label}</button>`;
}

function renderUsageChart(points, metric) {
  const width = 760;
  const height = 220;
  const pad = { top: 16, right: 18, bottom: 34, left: 52 };
  const values = points.map((point) => metricValue(point, metric));
  const max = Math.max(1, ...values);
  const chartWidth = width - pad.left - pad.right;
  const chartHeight = height - pad.top - pad.bottom;
  const coordinates = values.map((value, index) => {
    const x = points.length <= 1 ? pad.left + chartWidth / 2 : pad.left + (index / (points.length - 1)) * chartWidth;
    const y = pad.top + chartHeight - (value / max) * chartHeight;
    return { x, y, value, point: points[index] };
  });
  const grid = [0, 1, 2, 3].map((index) => {
    const y = pad.top + (index / 3) * chartHeight;
    const value = max - (index / 3) * max;
    return `<line class="usage-grid-line" x1="${pad.left}" y1="${y.toFixed(1)}" x2="${width - pad.right}" y2="${y.toFixed(1)}"></line><text class="usage-axis-label" x="${pad.left - 10}" y="${(y + 4).toFixed(1)}" text-anchor="end">${esc(formatAxisValue(value, metric))}</text>`;
  }).join('');
  if (coordinates.length === 0) return '<div class="usage-chart-empty"><span>暂无调用数据</span><small>完成请求后，Token 与费用趋势会在这里显示。</small></div>';
  const line = coordinates.map(({ x, y }) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${pad.left},${pad.top + chartHeight} ${line} ${coordinates.at(-1).x.toFixed(1)},${pad.top + chartHeight}`;
  const dots = coordinates.slice(-12).map(({ x, y, value, point }) => `<circle class="usage-point" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3"><title>${esc(formatChartDay(point.dateKey))} · ${esc(formatAxisValue(value, metric))}</title></circle>`).join('');
  return `<div class="usage-chart" role="img" aria-label="${esc(metricLabel(metric))}按日趋势图"><svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true"><g>${grid}</g><polygon class="usage-area" points="${area}"></polygon><polyline class="usage-line" points="${line}"></polyline>${dots}<text class="usage-axis-label" x="${pad.left}" y="${height - 8}">${esc(formatChartDay(points[0].dateKey))}</text><text class="usage-axis-label" x="${width - pad.right}" y="${height - 8}" text-anchor="end">${esc(formatChartDay(points.at(-1).dateKey))}</text></svg></div>`;
}

function renderRecentRequests(requests) {
  if (requests.length === 0) return '<div class="overview-empty">暂无请求记录，等待代理收到调用。</div>';
  return `<div class="recent-request-list">${requests.map((request) => {
    const ok = Number(request.data?.status_code) < 400;
    const data = request.data || {};
    const clientModel = data.client_model ? esc(data.client_model) : '未提供模型名';
    const models = data.upstream_model ? `${clientModel} <span>→ ${esc(data.upstream_model)}</span>` : clientModel;
    return `<div class="recent-request-item"><span class="request-status ${ok ? 'ok' : 'failed'}">${ok ? '正常' : '异常'}</span><div class="recent-request-main"><strong>${models}</strong><span>${esc(data.route || '-')}</span></div><time>${esc(formatChartTime(request.timestamp))}</time><b>${esc(String(data.status_code ?? '-'))}</b></div>`;
  }).join('')}</div>`;
}

function buildOverviewSnapshot(events) {
  const ordered = [...(Array.isArray(events) ? events : [])].sort((left, right) => {
    const byTime = new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime();
    return Number.isFinite(byTime) && byTime !== 0 ? byTime : Number(left.id || 0) - Number(right.id || 0);
  });
  const usageByKey = new Map();
  const dayByKey = new Map();
  let requestCount = 0;
  let successes = 0;
  let failures = 0;
  for (const event of ordered) {
    const data = event?.data || {};
    const dateKey = toDayKey(event.timestamp);
    if (!dateKey) continue;
    const day = dayByKey.get(dateKey) || { dateKey, timestamp: event.timestamp, requests: 0, tokens: 0, cost: 0 };
    if (isProxyRequest(event)) {
      requestCount += 1;
      if (Number(data.status_code) >= 400) failures += 1; else successes += 1;
      day.requests += 1;
    } else if (event?.type === 'quota.changed') {
      const key = `${data.provider_id || '-'}:${data.key_id || '-'}`;
      usageByKey.set(key, { requests: toNumber(data.requests_used), tokens: toNumber(data.tokens_used), cost: toNumber(data.cost_usd) });
    }
    day.tokens = latestTotal(usageByKey, 'tokens');
    day.cost = latestTotal(usageByKey, 'cost');
    dayByKey.set(dateKey, day);
  }
  const dailySnapshots = [...dayByKey.values()].sort((left, right) => left.dateKey.localeCompare(right.dateKey));
  let previousTokens = 0;
  let previousCost = 0;
  const points = dailySnapshots.map((day) => {
    const tokens = day.tokens >= previousTokens ? day.tokens - previousTokens : day.tokens;
    const cost = day.cost >= previousCost ? day.cost - previousCost : day.cost;
    previousTokens = day.tokens;
    previousCost = day.cost;
    return { ...day, tokens, cost };
  });
  return {
    points: points.slice(-30),
    requests: requestCount,
    tokens: latestTotal(usageByKey, 'tokens'),
    cost: latestTotal(usageByKey, 'cost'),
    successes,
    failures,
    recentRequests: ordered.filter(isProxyRequest).slice(-5).reverse(),
  };
}

function isProxyRequest(event) {
  return event?.type === 'request.completed' && String(event.data?.route || '').startsWith('/v1/');
}

function latestTotal(usageByKey, field) {
  let total = 0;
  for (const usage of usageByKey.values()) total += toNumber(usage[field]);
  return total;
}

function metricValue(point, metric) {
  return metric === 'cost' ? point.cost : metric === 'requests' ? point.requests : point.tokens;
}

function metricLabel(metric) {
  return metric === 'cost' ? '费用' : metric === 'requests' ? '请求数' : 'Token';
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function formatInteger(value) { return Math.round(value).toLocaleString('zh-CN'); }
function formatCompact(value) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return formatInteger(value);
}
function formatMoney(value) { return `$${value.toFixed(4)}`; }
function formatAxisValue(value, metric) { return metric === 'cost' ? `$${value.toFixed(3)}` : metric === 'requests' ? formatInteger(value) : formatCompact(value); }
function formatChartTime(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' }) : '-';
}

function toDayKey(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toLocaleDateString('sv-SE');
}

function formatChartDay(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[2]}-${match[3]}` : '-';
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
