export function parseJsonSafe(text, fallback) {
  try {
    return text.trim() ? JSON.parse(text) : fallback;
  } catch {
    throw new Error('JSON 字段格式不正确');
  }
}

export function readQuotaInputs(prefix) {
  const read = (suffix) => document.getElementById(`${prefix}-${suffix}`)?.value?.trim() || '';
  const reqRaw = read('max-req');
  const tokRaw = read('max-tok');
  const costRaw = read('max-cost');
  const inputRateRaw = read('input-cost');
  const outputRateRaw = read('output-cost');
  const thrRaw = read('threshold');

  // 全部留空表示继承供应商配额，必须保留 undefined 语义。
  if (!reqRaw && !tokRaw && !costRaw && !inputRateRaw && !outputRateRaw && !thrRaw) return undefined;

  const max_requests = reqRaw ? Number(reqRaw) : null;
  const max_tokens = tokRaw ? Number(tokRaw) : null;
  if (reqRaw && (!Number.isFinite(max_requests) || max_requests <= 0)) {
    throw new Error('请求次数上限必须为正数');
  }
  if (tokRaw && (!Number.isFinite(max_tokens) || max_tokens <= 0)) {
    throw new Error('Token 总量上限必须为正数');
  }

  const quota = { max_requests, max_tokens };
  for (const [raw, field, label] of [
    [costRaw, 'max_cost_usd', '费用上限'],
    [inputRateRaw, 'input_cost_per_million', '输入 Token 单价'],
    [outputRateRaw, 'output_cost_per_million', '输出 Token 单价'],
  ]) {
    if (!raw) continue;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${label}必须为正数`);
    quota[field] = value;
  }
  if (thrRaw) {
    const threshold = Number(thrRaw);
    if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
      throw new Error('软停阈值必须在 (0, 1] 之间');
    }
    quota.soft_stop_threshold = threshold;
  }
  return quota;
}
