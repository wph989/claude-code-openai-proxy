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

/**
 * 时间工具：统一输出北京时间。
 */
export function nowBeijingIso(): string {
  return formatBeijingDate(new Date());
}

export function formatBeijingDate(date: Date): string {
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((item) => [item.type, item.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}+08:00`;
}

export function toBeijingDateStr(date: Date): string {
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((item) => [item.type, item.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}
