// lib/format.ts — pure helpers, safe for client and server

export function humanDuration(ms?: number): string {
  if (!ms) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m ${rs}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm}m`;
}

export function humanTime(ms?: number): string {
  if (!ms) return "—";
  const d = new Date(ms);
  return d.toLocaleString("en-US", {
    timeZone: "America/Chicago",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

export function relativeTime(ms?: number): string {
  if (!ms) return "—";
  const diff = Date.now() - ms;
  const abs = Math.abs(diff);
  const past = diff >= 0;
  const s = Math.round(abs / 1000);
  if (s < 60) return past ? `${s}s ago` : `in ${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return past ? `${m}m ago` : `in ${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return past ? `${h}h ago` : `in ${h}h`;
  const days = Math.round(h / 24);
  return past ? `${days}d ago` : `in ${days}d`;
}
