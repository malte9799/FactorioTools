import { UNIT_SECONDS, type TimeUnit } from "./state.js";

/** A rate in the chosen unit, short: 1.25, 37.5, 450, 12.3k. */
export function fmtRate(perSecond: number, unit: TimeUnit): string {
  return fmtNumber(perSecond * UNIT_SECONDS[unit]);
}

export function fmtNumber(v: number): string {
  const a = Math.abs(v);
  if (a < 1e-9) return "0";
  if (a >= 1e6) return trim((v / 1e6).toFixed(a >= 1e7 ? 1 : 2)) + "M";
  if (a >= 1e4) return trim((v / 1e3).toFixed(a >= 1e5 ? 0 : 1)) + "k";
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return trim(v.toFixed(1));
  if (a >= 0.01) return trim(v.toFixed(2));
  return v.toPrecision(2);
}

function trim(s: string): string {
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

export function fmtMachines(v: number): string {
  if (v >= 100) return v.toFixed(0);
  if (v >= 10) return trim(v.toFixed(1));
  return trim(v.toFixed(2));
}

export function fmtPower(watts: number): string {
  if (watts >= 1e9) return trim((watts / 1e9).toFixed(2)) + " GW";
  if (watts >= 1e6) return trim((watts / 1e6).toFixed(watts >= 1e8 ? 0 : 1)) + " MW";
  if (watts >= 1e3) return trim((watts / 1e3).toFixed(0)) + " kW";
  return watts.toFixed(0) + " W";
}

export function fmtPercent(fraction: number): string {
  const p = fraction * 100;
  return (p > 0 ? "+" : "") + trim(p.toFixed(Math.abs(p) < 10 ? 1 : 0)) + "%";
}

export const UNIT_LABEL: Record<TimeUnit, string> = { s: "/s", min: "/m", h: "/h" };
