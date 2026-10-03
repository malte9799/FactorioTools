/** The circuit half of the hover card: what an entity's red and green
 *  wires carry, its condition, and what a combinator puts out. */
import { getRenderCatalog, type BpCircuitCondition, type BpSignalId, type PlacedEntity } from "@factoriotools/engine";
import { combinatorKind, parseSignalKey, testCondition, type Signals } from "@factoriotools/sim";
import { escapeHtml } from "../tools/blueprint-editor/html.js";
import { iconHtml } from "../tools/blueprint-editor/legacy-view/icons.js";
import type { LabFactory } from "./factory.js";
import { compactValue } from "./overlay.js";

const MAX_ROWS = 8;

export function signalLabel(name: string): string {
  const catalog = getRenderCatalog();
  return catalog.itemNames[name] ?? catalog.signals?.[name]?.localised ?? catalog.entities[name]?.localised ?? name.replace(/^signal-/, "").replace(/-/g, " ");
}

function signalRows(signals: Signals): string {
  if (!signals.size) return `<div class="lab-card-row"><span>—</span><span></span></div>`;
  const list = [...signals].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  const rows = list.slice(0, MAX_ROWS).map(([k, v]) => {
    const s = parseSignalKey(k);
    const q = s.quality ? ` (${s.quality})` : "";
    return `<div class="lab-card-row"><span>${iconHtml(s.name)} ${escapeHtml(signalLabel(s.name) + q)}</span><span>${compactValue(v)}</span></div>`;
  });
  if (list.length > MAX_ROWS) rows.push(`<div class="lab-card-row"><span>and ${list.length - MAX_ROWS} more</span><span></span></div>`);
  return rows.join("");
}

const COMPARATOR_TEXT: Record<string, string> = { ">=": "≥", "<=": "≤", "!=": "≠", "==": "=" };

/** "Iron plate > 50", in words a player reads. */
export function conditionText(cond: BpCircuitCondition | undefined): string {
  if (!cond?.first_signal?.name) return "no condition set";
  const sig = (s: BpSignalId) => signalLabel(s.name!);
  const cmp = COMPARATOR_TEXT[cond.comparator ?? "<"] ?? cond.comparator ?? "<";
  return `${sig(cond.first_signal)} ${cmp} ${cond.second_signal?.name ? sig(cond.second_signal) : (cond.constant ?? 0)}`;
}

function networkBlock(f: LabFactory, e: PlacedEntity, side: 1 | 2, heading: string): string {
  const out: string[] = [];
  for (const color of ["red", "green"] as const) {
    const net = f.circuits.network(e.entityNumber, color, side);
    if (!net) continue;
    out.push(`<div class="lab-card-net lab-card-net-${color}">${heading} ${color} · network ${net.id + 1}</div>${signalRows(net.values)}`);
  }
  return out.join("");
}

/** Empty when the entity has nothing circuit-related to say. */
export function circuitCardHtml(f: LabFactory, e: PlacedEntity): string {
  const c = f.circuits;
  const n = e.entityNumber;
  const parts: string[] = [];
  const cb = e.controlBehavior;
  const kind = combinatorKind(e.name);
  const wired = c.isWired(n);
  if (kind === "constant") parts.push(`<div class="lab-card-why">${cb?.is_on === false ? "Switched off." : "Outputs its signals every tick."}</div>`);
  if (kind && kind !== "constant") {
    parts.push(networkBlock(f, e, 1, "In"));
    parts.push(`<div class="lab-card-net">Output</div>${signalRows(c.combinatorOutput(n) ?? new Map())}`);
    parts.push(networkBlock(f, e, 2, "Out"));
    return parts.join("");
  }
  if (/lamp/.test(e.name)) {
    const lamp = c.lamp(n);
    parts.push(`<div class="lab-card-why">${lamp.on ? "Lit" : "Off"}${cb?.circuit_condition && wired ? `: ${escapeHtml(conditionText(cb.circuit_condition))}` : ""}.</div>`);
  } else if (/display-panel/.test(e.name)) {
    const shown = c.display(n);
    parts.push(`<div class="lab-card-why">${shown ? `Showing ${shown.icon?.name ? iconHtml(shown.icon.name) : ""} ${escapeHtml(shown.text ?? "")}` : "No message's condition holds."}</div>`);
  } else if (wired && cb && (cb.circuit_enabled ?? cb.circuit_enable_disable)) {
    const on = testCondition(cb.circuit_condition, c.merged(n));
    parts.push(`<div class="lab-card-why" style="color:${on ? "#93d977" : "#e2765a"}">${on ? "Enabled" : "Disabled"} by circuit: ${escapeHtml(conditionText(cb.circuit_condition))}</div>`);
  }
  if (wired) parts.push(networkBlock(f, e, 1, kind === "constant" ? "Out" : ""));
  return parts.join("");
}
