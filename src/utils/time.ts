const formatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit'
});

// 预缓存 part 索引，避免每次 formatToParts 都创建对象映射
const PART_INDEX = (() => {
  const sample = formatter.formatToParts(new Date(0));
  const idx: Record<string, number> = {};
  for (let i = 0; i < sample.length; i++) {
    idx[sample[i].type] = i;
  }
  return idx;
})();

/**
 * 时间工具：统一输出北京时间。
 */
export function nowBeijingIso(): string {
  return formatBeijingDate(new Date());
}

export function formatBeijingDate(date: Date): string {
  const parts = formatter.formatToParts(date);
  const y = parts[PART_INDEX.year].value;
  const m = parts[PART_INDEX.month].value;
  const d = parts[PART_INDEX.day].value;
  const h = parts[PART_INDEX.hour].value;
  const mi = parts[PART_INDEX.minute].value;
  const s = parts[PART_INDEX.second].value;
  return `${y}-${m}-${d}T${h}:${mi}:${s}+08:00`;
}

export function toBeijingDateStr(date: Date): string {
  const parts = formatter.formatToParts(date);
  const y = parts[PART_INDEX.year].value;
  const m = parts[PART_INDEX.month].value;
  const d = parts[PART_INDEX.day].value;
  return `${y}-${m}-${d}`;
}
