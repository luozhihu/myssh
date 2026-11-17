function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/** 按 Go time.Duration.String() 的常用形态格式化毫秒。 */
export function goDuration(ms: number): string {
  if (ms < 0) return `-${goDuration(-ms)}`;
  if (ms === 0) return "0s";
  if (ms < 1000) return `${ms}ms`;
  const totalSec = Math.floor(ms / 1000);
  const fracMs = ms % 1000;
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  const sec = fracMs
    ? `${seconds}.${pad(fracMs, 3).replace(/0+$/, "")}`
    : String(seconds);
  if (hours > 0) return `${hours}h${minutes}m${sec}s`;
  if (minutes > 0) return `${minutes}m${sec}s`;
  return `${sec}s`;
}

/** Go time.Time JSON 编码（RFC3339Nano，本地时区，去掉小数末尾的 0）。 */
export function goTimestamp(date: Date): string {
  const base =
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  const fraction = `${pad(date.getMilliseconds(), 3)}000000`.replace(/0+$/, "");
  const offset = -date.getTimezoneOffset();
  let zone = "Z";
  if (offset !== 0) {
    const sign = offset > 0 ? "+" : "-";
    const abs = Math.abs(offset);
    zone = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  }
  return fraction ? `${base}.${fraction}${zone}` : `${base}${zone}`;
}

/** LoginFlow / RC trace 使用的时间格式：2006-01-02 15:04:05.000。 */
export function traceTimestamp(date: Date): string {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.` +
    pad(date.getMilliseconds(), 3)
  );
}
