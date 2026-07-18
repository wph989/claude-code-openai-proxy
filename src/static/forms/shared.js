export function parseJsonSafe(text, fallback) {
  try {
    return text.trim() ? JSON.parse(text) : fallback;
  } catch {
    throw new Error('JSON 字段格式不正确');
  }
}

export function readQuotaInputs(prefix) {
  const reqRaw = document.getElementById(`${prefix}-max-req`).value.trim();
  const tokRaw = document.getElementById(`${prefix}-max-tok`).value.trim();
  const thrRaw = document.getElementById(`${prefix}-threshold`).value.trim();

  // 全部留空表示继承供应商配额，必须保留 undefined 语义。
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
