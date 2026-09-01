export function formatRate(value: number): string {
  const abs = Math.abs(value);
  if (abs === 0) return "0";
  if (abs >= 1_000_000) return (value / 1_000_000).toFixed(2) + "M";
  if (abs >= 10_000) return (value / 1000).toFixed(1) + "k";
  if (abs >= 100) return value.toFixed(0);
  if (abs >= 10) return value.toFixed(1);
  if (abs >= 0.1) return value.toFixed(2);
  return value.toPrecision(2);
}

export function formatSigned(value: number): string {
  if (Math.abs(value) < 1e-9) return "0";
  return (value > 0 ? "+" : "") + formatRate(value);
}

export function formatPower(watts: number): string {
  if (watts >= 1e9) return (watts / 1e9).toFixed(2) + " GW";
  if (watts >= 1e6) return (watts / 1e6).toFixed(2) + " MW";
  if (watts >= 1e3) return (watts / 1e3).toFixed(1) + " kW";
  return watts.toFixed(0) + " W";
}

export function formatMachines(value: number): string {
  const rounded = Math.abs(value) < 0.005 ? 0 : value;
  return (rounded > 0 ? "+" : "") + rounded.toFixed(2).replace(/\.00$/, "");
}

export function formatPercent(fraction: number): string {
  if (Math.abs(fraction) < 1e-9) return "0%";
  return (fraction > 0 ? "+" : "") + (fraction * 100).toFixed(0) + "%";
}
