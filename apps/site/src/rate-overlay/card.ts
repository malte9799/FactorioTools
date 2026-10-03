/** The hover card: what the thing under the cursor is doing, in words. */
import { getRenderCatalog } from "@factoriotools/engine";
import { escapeHtml } from "../tools/blueprint-editor/html.js";
import { circuitCardHtml } from "./circuit-card.js";
import { machineStatus, type LabFactory } from "./factory.js";
import { itemLabel, recipeLabel, type Issue } from "./issues.js";
import { laneState, statusColor, type HoverTarget } from "./overlay.js";
import { formatRate, PALETTES, type LabSettings } from "./settings.js";

export function hoverCardHtml(f: LabFactory, hover: HoverTarget, settings: LabSettings, issues: Issue[]): string {
  const base = baseCardHtml(f, hover, settings, issues);
  const entity =
    hover.kind === "circuit" ? hover.entity
    : hover.kind === "machine" ? hover.machine.entity
    : hover.kind === "inserter" ? hover.inserter.entity
    : hover.kind === "box" ? hover.box.entity
    : hover.kind === "belt" ? f.entities.find((e) => Math.floor(e.x) === hover.node.x && Math.floor(e.y) === hover.node.y)
    : undefined;
  const circuit = entity ? circuitCardHtml(f, entity) : "";
  return base + circuit;
}

function baseCardHtml(f: LabFactory, hover: HoverTarget, settings: LabSettings, issues: Issue[]): string {
  if (hover.kind === "circuit") {
    const e = hover.entity;
    return `<div class="lab-card-title">${escapeHtml(getRenderCatalog().entities[e.name]?.localised ?? f.data.items[e.name]?.localised ?? e.name)}</div>`;
  }
  const pal = PALETTES[settings.style.palette];
  const row = (a: string, b: string) => `<div class="lab-card-row"><span>${a}</span><span>${b}</span></div>`;
  const rate = (perSecond: number) => formatRate(perSecond, settings.style.rateUnit);
  if (hover.kind === "machine") {
    const m = hover.machine;
    const st = machineStatus(m);
    const col = statusColor(pal, st);
    const product = m.products[0]?.name ?? "";
    const why =
      st === "working" ? "Running at full speed."
      : st === "arm" ? "Waiting on its input inserter between swings."
      : st === "starved" ? `Nothing to take: no ${escapeHtml(itemLabel(f.data, m.missing ?? m.ingredients[0]?.name ?? ""))} reaches its inserter.`
      : st === "output" ? "Its output can't leave fast enough."
      : "Idle.";
    return `<div class="lab-card-title">${escapeHtml(recipeLabel(f.data, m.recipe))}</div>
      <div class="lab-card-bar"><i style="width:${Math.round(m.uptime * 100)}%;background:${col}"></i></div>
      ${row("Uptime", `${Math.round(m.uptime * 100)}%`)}
      ${row(escapeHtml(itemLabel(f.data, product)), `${rate(f.machineRate(m))} of ${rate(f.machineMaxRate(m))}`)}
      ${m.ingredients.map((i) => row(escapeHtml(itemLabel(f.data, i.name)), `${m.buffer.get(i.name) ?? 0} held · uses ${rate(f.machineNeed(m, i.name))}`)).join("")}
      <div class="lab-card-why" style="color:${col}">${why}</div>`;
  }
  if (hover.kind === "box") {
    const box = hover.box;
    const into = f.inserters.filter((i) => i.drop.kind === "box" && i.drop.box === box);
    const outOf = f.inserters.filter((i) => i.pickup.kind === "box" && i.pickup.box === box);
    const held = [...box.contents].filter(([, n]) => n > 0);
    const name = box.entity ? (f.data.items[box.entity.name]?.localised ?? box.entity.name) : "Items on the ground";
    return `<div class="lab-card-title">${escapeHtml(name)}</div>
      ${held.length ? held.map(([n, c]) => row(escapeHtml(itemLabel(f.data, n)), String(c))).join("") : row("Holding", "nothing")}
      ${row("In", `${rate(into.reduce((a, i) => a + i.moved, 0))} from ${into.length} arm${into.length === 1 ? "" : "s"}`)}
      ${row("Out", `${rate(outOf.reduce((a, i) => a + i.moved, 0))} to ${outOf.length} arm${outOf.length === 1 ? "" : "s"}`)}
      <div class="lab-card-why">${box.entity ? "A buffer between the arms that fill and empty it." : "One arm drops here and another picks up."} Holds up to ${box.capacity}.</div>`;
  }
  if (hover.kind === "inserter") {
    const ins = hover.inserter;
    return `<div class="lab-card-title">${escapeHtml(f.data.inserters[ins.entity.name]?.localised ?? ins.entity.name)}</div>
      ${row("Busy", `${Math.round(ins.busy * 100)}%`)}
      ${row("Moving", `${rate(ins.moved)} of ${rate(ins.maxRate)}`)}
      ${row("Holding", ins.hand ? `${ins.handCount} × ${escapeHtml(itemLabel(f.data, ins.hand))}` : "nothing")}
      <div class="lab-card-why">${ins.busy > 0.9 ? "Swinging nonstop: this arm is a limit." : ins.pickup.kind === "belt" ? "Mostly waiting for something to pick up." : "Keeping up."}</div>`;
  }
  if (hover.kind !== "belt") return "";
  const node = hover.node;
  const short = new Set(issues.flatMap((i) => [...i.nodes]));
  const lanes = ([0, 1] as const).map((lane) => {
    const ls = laneState(f, node, lane, short);
    const items = f.belts.laneItems(node.line!, lane);
    const seg = node.line!.lanes[lane].segments[f.belts.segmentOf(node, lane)]!;
    const here = items.filter((i) => i.pos >= seg.start && i.pos < seg.start + seg.length).map((i) => i.item);
    const what = [...new Set(here)].map((n) => itemLabel(f.data, n)).join(", ") || "—";
    const word = { flow: "moving", held: "backed up", empty: "empty", short: "running dry" }[ls.state];
    return row(`${lane ? "Right" : "Left"} · ${escapeHtml(what)}`, `${rate(ls.rate)} · ${word}`);
  });
  const name = f.data.belts[node.name]?.localised ?? node.name;
  return `<div class="lab-card-title">${escapeHtml(name)}</div>${lanes.join("")}
    <div class="lab-card-why">Up to ${rate((node.speed * 60) / 64)} per lane, times the stack size.</div>`;
}
