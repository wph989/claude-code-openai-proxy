export class ApiClientError extends Error {
  constructor(message, status, data = null) {
    super(message);
    this.name = 'ApiClientError';
    this.status = status;
    this.data = data;
  }
}

async function request(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.ifMatch != null) headers['If-Match'] = `"${options.ifMatch}"`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(path, {
    method: options.method || 'GET',
    credentials: 'include',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  });

  if (response.status === 401) {
    // 所有管理 API 统一处理会话失效，避免某个按钮只显示模糊的“操作失败”。
    window.location.href = '/login';
    throw new ApiClientError('未登录或会话已失效。', 401);
  }

  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json')
    ? await response.json()
    : await response.text();
  if (!response.ok) {
    const message = data?.error?.message || data?.message || `请求失败（HTTP ${response.status}）`;
    throw new ApiClientError(message, response.status, data);
  }
  return { data, revision: readRevision(response) };
}

function readRevision(response) {
  const raw = response.headers.get('etag')?.replace(/^W\//, '').replace(/^"|"$/g, '');
  const revision = Number(raw);
  return Number.isSafeInteger(revision) && revision > 0 ? revision : null;
}

function keyPath(providerId, keyId, suffix = '') {
  return `/api/keys/${encodeURIComponent(providerId)}/${encodeURIComponent(keyId)}${suffix}`;
}

export const AdminApi = {
  session: () => request('/api/admin/session'),
  logout: () => request('/api/admin/logout', { method: 'POST' }),
  loadConfig: () => request('/api/config'),
  loadConfigHistory: (limit = 20) => request(`/api/config/history?limit=${encodeURIComponent(limit)}`),
  rollbackConfig: (targetRevision, revision) => request(
    `/api/config/history/${encodeURIComponent(targetRevision)}/rollback`,
    { method: 'POST', ifMatch: revision },
  ),
  previewConfig: (config, revision, signal) => request('/api/config/preview', {
    method: 'POST', body: config, ifMatch: revision, signal,
  }),
  saveConfig: (config, revision) => request('/api/config', {
    method: 'PUT', body: config, ifMatch: revision,
  }),
  updateProxyToken: (token, revision) => request('/api/config/proxy-token', {
    method: 'PUT', body: { token }, ifMatch: revision,
  }),
  loadKeys: (providerId) => request(`/api/keys/${encodeURIComponent(providerId)}`),
  addKeys: (providerId, keys) => request(`/api/keys/${encodeURIComponent(providerId)}`, {
    method: 'POST', body: { keys },
  }),
  resetAllKeys: (providerId) => request(`/api/keys/${encodeURIComponent(providerId)}/reset-all`, {
    method: 'PUT',
  }),
  keyAction: (providerId, keyId, action) => request(keyPath(providerId, keyId, `/${action}`), {
    method: 'PUT',
  }),
  updateKeyNote: (providerId, keyId, note) => request(keyPath(providerId, keyId, '/note'), {
    method: 'PUT', body: { note },
  }),
  deleteKey: (providerId, keyId) => request(keyPath(providerId, keyId), { method: 'DELETE' }),
  updateKeyQuota: (providerId, keyId, quota) => request(keyPath(providerId, keyId, '/quota'), {
    method: 'PUT', body: { quota },
  }),
  testProvider: (providerId) => request(`/api/providers/${encodeURIComponent(providerId)}/test`, {
    method: 'POST',
  }),
  resetKeyQuota: (providerId, keyId) => request(keyPath(providerId, keyId, '/quota/reset'), {
    method: 'POST',
  }),
  openEventStream: ({ onEvent, onOpen, onError }) => {
    const source = new EventSource('/api/admin/events', { withCredentials: true });
    source.onmessage = (message) => {
      try {
        onEvent?.(JSON.parse(message.data));
      } catch {
        // 单条异常事件不应打断 EventSource 后续自动重连和正常事件处理。
      }
    };
    source.onopen = () => onOpen?.();
    source.onerror = () => onError?.();
    return source;
  },
};
