/** Indian-locale number formatting, matching the prototype's toLocaleString('en-IN'). */
export function fmt(n: number): string {
  return Number(n || 0).toLocaleString("en-IN");
}

export function fmtKg(n: number): string {
  return `${fmt(n)} kg`;
}

export function fmtInr(n: number): string {
  return `₹ ${fmt(Math.round(n))}`;
}
