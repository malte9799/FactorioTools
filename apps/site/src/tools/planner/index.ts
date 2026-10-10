/** Production Planner: name what you want and how fast, get the whole
 *  factory behind it — every recipe, machine, module, belt and drill, down
 *  to the ore — as a flow diagram or a table.
 *
 *  The solving lives in packages/engine/src/planner (DOM-free and tested);
 *  this file owns the page: state, the target bar, panels and dialogs. */

import "./planner.css";
import {
  buildPlannerData,
  canUseModule,
  getRenderCatalog,
  loadData,
  plannableItems,
  solvePlan,
  type ModuleSetup,
  type PlanResult,
  type PlannerData,
} from "@factoriotools/engine";
import { escapeHtml } from "../blueprint-editor/html.js";
import { FlowGraph, setFluidCheck } from "./graph.js";
import { UNIT_LABEL } from "./format.js";
import { inspectorHtml, moduleChooserHtml, pickerHtml, settingsHtml, summaryHtml, tableHtml, welcomeHtml } from "./panels.js";
import { iconsReady, itemColor, loadItemColors, sprite } from "./sprites.js";
import { defaultState, loadState, saveState, shareLink, UNIT_SECONDS, type PlannerState, type TimeUnit } from "./state.js";

const TEMPLATE = `
  <div class="planner">
    <header class="pl-bar">
      <span class="pl-bar-label">Make</span>
      <div class="pl-targets" role="list"></div>
      <div class="pl-bar-tools">
        <div class="pl-seg" role="group" aria-label="Rates per">
          <button type="button" data-unit="s">/s</button><button type="button" data-unit="min">/min</button><button type="button" data-unit="h">/h</button>
        </div>
        <div class="pl-seg" role="group" aria-label="View">
          <button type="button" data-view="flow">Flow</button><button type="button" data-view="table">Table</button>
        </div>
        <button type="button" class="pl-tool" data-action="settings" data-tip="Settings" data-tip-sub="Machines, modules, fuel, research">⚙<span>Settings</span></button>
        <button type="button" class="pl-tool" data-action="share" data-tip="Copy a link to this plan">⧉<span>Share</span></button>
      </div>
    </header>
    <aside class="pl-side gui-window" aria-label="Summary">
      <div class="gui-titlebar"><span>Overview</span><span class="grip"></span></div>
      <div class="gui-body pl-side-body"></div>
    </aside>
    <section class="pl-main"></section>
    <aside class="pl-insp gui-window" aria-label="Details" hidden>
      <div class="gui-titlebar"><span>Details</span><span class="grip"></span><button type="button" class="gui-close" data-action="close-insp" aria-label="Close">✕</button></div>
      <div class="gui-body pl-insp-body"></div>
    </aside>
    <div class="pl-modal" hidden>
      <div class="pl-modal-card gui-window" role="dialog" aria-modal="true">
        <div class="gui-titlebar"><span class="pl-modal-title"></span><span class="grip"></span><button type="button" class="gui-close" data-action="close-modal" aria-label="Close">✕</button></div>
        <div class="gui-body pl-modal-body"></div>
      </div>
    </div>
    <div class="pl-pop gui-window" hidden><div class="gui-body"></div></div>
    <div class="pl-tip" hidden></div>
    <div class="pl-loading">Loading game data…</div>
  </div>`;

export function mountPlanner(root: HTMLElement): () => void {
  root.innerHTML = TEMPLATE;
  const el = root.querySelector<HTMLElement>(".planner")!;
  const q = <T extends HTMLElement>(sel: string) => el.querySelector<T>(sel)!;
  const targetsEl = q(".pl-targets");
  const sideBody = q(".pl-side-body");
  const main = q(".pl-main");
  const insp = q(".pl-insp");
  const inspBody = q(".pl-insp-body");
  const modal = q(".pl-modal");
  const modalBody = q(".pl-modal-body");
  const modalTitle = q(".pl-modal-title");
  const pop = q(".pl-pop");
  const tip = q(".pl-tip");

  let disposed = false;
  let pd: PlannerData | null = null;
  let plannable = new Set<string>();
  let state: PlannerState = defaultState();
  let result: PlanResult | null = null;
  let selected: string | null = null;
  let modalKind: "picker" | "settings" | null = null;
  let pickerGroup = "intermediate-products";
  let pickerQuery = "";
  let onPick: ((item: string) => void) | null = null;
  let onPopPick: ((value: string) => void) | null = null;

  const graph = new FlowGraph({
    onSelect(id) {
      select(id);
    },
  });

  void (async () => {
    const data = await loadData();
    await iconsReady();
    if (disposed) return;
    pd = buildPlannerData(data, getRenderCatalog());
    setFluidCheck((item) => pd?.items[item]?.kind === "fluid");
    plannable = new Set(plannableItems(pd).map((i) => i.name));
    state = loadState(pd);
    q(".pl-loading").remove();
    recompute();
    // Colours are sampled from the icon sheet; draw again once they are in.
    void loadItemColors(Object.keys(pd.items)).then(() => !disposed && render());
  })();

  function recompute(opts: { keepBar?: boolean } = {}): void {
    if (!pd) return;
    result = state.targets.some((t) => t.rate > 0) ? solvePlan(pd, state.settings, state.targets) : null;
    if (selected && result && !nodeExists(selected)) selected = null;
    saveState(state);
    render(opts);
  }

  function nodeExists(id: string): boolean {
    if (!result) return false;
    if (result.steps.some((s) => s.id === id)) return true;
    return result.flows.some((f) => f.from === id || f.to === id);
  }

  /* ------------------------------------------------------------- render */

  function render(opts: { keepBar?: boolean } = {}): void {
    if (!pd) return;
    if (!opts.keepBar) renderBar();
    for (const b of el.querySelectorAll<HTMLButtonElement>("[data-unit]")) b.classList.toggle("is-on", b.dataset.unit === state.unit);
    for (const b of el.querySelectorAll<HTMLButtonElement>("[data-view]")) b.classList.toggle("is-on", b.dataset.view === state.view);

    if (!result) {
      el.classList.add("is-empty");
      sideBody.innerHTML = `<p class="pl-hint">Add something to make, and the totals land here.</p>`;
      main.innerHTML = welcomeHtml(pd);
      insp.hidden = true;
      return;
    }
    el.classList.remove("is-empty");
    sideBody.innerHTML = (result.ok ? "" : `<p class="pl-warn">${escapeHtml(result.message ?? "")}</p>`) + summaryHtml(pd, result, state);

    if (state.view === "flow") {
      if (graph.el.parentElement !== main) {
        main.innerHTML = "";
        main.appendChild(graph.el);
      }
      graph.render(pd, result, state.unit);
      graph.select(selected);
    } else {
      main.innerHTML = tableHtml(pd, result, state, selected);
    }
    renderInspector();
  }

  function renderBar(): void {
    if (!pd) return;
    const unit = state.unit;
    targetsEl.innerHTML = state.targets.map((t, i) => {
      const label = pd!.items[t.item]?.label ?? t.item;
      return `<div class="pl-target" role="listitem" style="--c:${itemColor(t.item)}">
        <button type="button" class="pl-slot" data-action="change-target" data-index="${i}" data-tip="${escapeHtml(label)}" data-tip-sub="Click to pick another item">${sprite(t.item, 32)}</button>
        <label class="pl-target-rate"><input type="number" inputmode="decimal" min="0" step="any" data-index="${i}" value="${+(t.rate * UNIT_SECONDS[unit]).toPrecision(6)}" aria-label="${escapeHtml(`${label} per ${unit}`)}"/><span>${UNIT_LABEL[unit]}</span></label>
        <button type="button" class="pl-target-x" data-action="remove-target" data-index="${i}" aria-label="${escapeHtml(`Remove ${label}`)}">✕</button>
      </div>`;
    }).join("") + `<button type="button" class="pl-slot is-add" data-action="add-target" data-tip="Add a product">+</button>`;
  }

  function renderInspector(): void {
    if (!pd || !result || !selected) {
      insp.hidden = true;
      return;
    }
    const markup = inspectorHtml(pd, result, state, selected);
    insp.hidden = !markup;
    const scroll = inspBody.scrollTop;
    inspBody.innerHTML = markup;
    inspBody.scrollTop = scroll;
  }

  function select(id: string | null): void {
    if (id === selected && id !== null) return;
    selected = id || null;
    graph.select(selected);
    if (state.view === "table" && pd && result) main.innerHTML = tableHtml(pd, result, state, selected);
    if (selected) inspBody.scrollTop = 0;
    renderInspector();
  }

  /* ------------------------------------------------------------ dialogs */

  function openModal(kind: "picker" | "settings"): void {
    modalKind = kind;
    modal.hidden = false;
    modal.dataset.kind = kind;
    renderModal();
    if (kind === "picker") modalBody.querySelector<HTMLInputElement>(".pl-search")?.focus();
  }

  function closeModal(): void {
    modal.hidden = true;
    modalKind = null;
    onPick = null;
    hideTip();
  }

  function renderModal(): void {
    if (!pd || !modalKind) return;
    if (modalKind === "picker") {
      modalTitle.textContent = "Pick an item";
      if (!modalBody.querySelector(".pl-search")) {
        modalBody.innerHTML = `<input class="pl-search" type="search" placeholder="Search items…" aria-label="Search items" autocomplete="off" spellcheck="false"/><div class="pl-pick"></div>`;
      }
      modalBody.querySelector<HTMLElement>(".pl-pick")!.innerHTML = pickerHtml(pd, pickerGroup, pickerQuery, plannable);
    } else {
      modalTitle.textContent = "Settings";
      const scroll = modalBody.scrollTop;
      modalBody.innerHTML = settingsHtml(pd, state);
      modalBody.scrollTop = scroll;
    }
  }

  function pickItem(cb: (item: string) => void): void {
    onPick = cb;
    pickerQuery = "";
    modalBody.innerHTML = "";
    openModal("picker");
  }

  function openPop(anchor: HTMLElement, markup: string, cb: (value: string) => void): void {
    hideTip();
    onPopPick = cb;
    pop.querySelector(".gui-body")!.innerHTML = markup;
    pop.hidden = false;
    const r = anchor.getBoundingClientRect();
    const p = pop.getBoundingClientRect();
    const x = Math.min(window.innerWidth - p.width - 8, Math.max(8, r.left + r.width / 2 - p.width / 2));
    const y = r.bottom + p.height + 8 > window.innerHeight ? r.top - p.height - 6 : r.bottom + 6;
    pop.style.left = `${x}px`;
    pop.style.top = `${Math.max(8, y)}px`;
  }

  function closePop(): void {
    pop.hidden = true;
    onPopPick = null;
  }

  /* ------------------------------------------------------------- tooltip */

  function showTip(target: HTMLElement | SVGElement, x: number, y: number): void {
    const title = target.getAttribute("data-tip");
    if (!title) return hideTip();
    const sub = target.getAttribute("data-tip-sub");
    const icon = target.getAttribute("data-tip-icon");
    tip.innerHTML = `${icon ? sprite(icon, 28) : ""}<div><b>${escapeHtml(title)}</b>${sub ? `<span>${escapeHtml(sub)}</span>` : ""}</div>`;
    tip.hidden = false;
    moveTip(x, y);
  }

  function moveTip(x: number, y: number): void {
    if (tip.hidden) return;
    const r = tip.getBoundingClientRect();
    const left = x + 16 + r.width > window.innerWidth - 4 ? x - r.width - 12 : x + 16;
    const top = y + 18 + r.height > window.innerHeight - 4 ? y - r.height - 10 : y + 18;
    tip.style.transform = `translate(${Math.max(4, left)}px, ${Math.max(4, top)}px)`;
  }

  function hideTip(): void {
    tip.hidden = true;
  }

  /* --------------------------------------------------------------- edits */

  function setModules(recipe: string, change: (setup: ModuleSetup) => void): void {
    if (!pd || !result) return;
    const step = result.steps.find((s) => s.recipe.id === recipe);
    if (!step) return;
    const setup: ModuleSetup = state.settings.modulesFor[recipe]
      ? structuredClone(state.settings.modulesFor[recipe]!)
      : { modules: [...step.modules], beacons: step.beacons, beaconModule: step.beaconModule || state.settings.defaultBeaconModule };
    change(setup);
    state.settings.modulesFor[recipe] = setup;
    recompute();
  }

  function onClick(ev: MouseEvent): void {
    const t = ev.target as HTMLElement;

    if (!pop.hidden && !t.closest(".pl-pop")) closePop();

    const popPick = t.closest<HTMLElement>(".pl-pop [data-pick]");
    if (popPick && onPopPick) {
      const cb = onPopPick;
      closePop();
      cb(popPick.dataset.pick ?? "");
      return;
    }
    const pick = t.closest<HTMLElement>(".pl-modal [data-pick]");
    if (pick && onPick) {
      const cb = onPick;
      closeModal();
      cb(pick.dataset.pick!);
      return;
    }
    const tab = t.closest<HTMLElement>(".pl-modal [data-group]");
    if (tab) {
      pickerGroup = tab.dataset.group!;
      pickerQuery = "";
      const search = modalBody.querySelector<HTMLInputElement>(".pl-search");
      if (search) search.value = "";
      renderModal();
      return;
    }
    if (t === modal) {
      closeModal();
      return;
    }

    const unitBtn = t.closest<HTMLElement>("[data-unit]");
    if (unitBtn) {
      state.unit = unitBtn.dataset.unit as TimeUnit;
      saveState(state);
      render();
      return;
    }
    const viewBtn = t.closest<HTMLElement>("[data-view]");
    if (viewBtn) {
      state.view = viewBtn.dataset.view === "table" ? "table" : "flow";
      saveState(state);
      render();
      return;
    }

    const a = t.closest<HTMLElement>("[data-action]");
    if (!a || !pd) return;
    const s = state.settings;
    const index = Number(a.dataset.index);
    const recipe = a.dataset.recipe ?? "";
    switch (a.dataset.action) {
      case "add-target":
        pickItem((item) => {
          const existing = state.targets.find((x) => x.item === item);
          if (!existing) state.targets.push({ item, rate: pd!.items[item]?.kind === "fluid" ? 10 : 1 });
          recompute();
          focusRate(state.targets.findIndex((x) => x.item === item));
        });
        break;
      case "quick": {
        const item = a.dataset.item!;
        if (!state.targets.some((x) => x.item === item)) state.targets.push({ item, rate: 1 });
        recompute();
        focusRate(state.targets.findIndex((x) => x.item === item));
        break;
      }
      case "change-target":
        pickItem((item) => {
          if (state.targets[index]) state.targets[index]!.item = item;
          recompute();
        });
        break;
      case "remove-target":
        state.targets.splice(index, 1);
        recompute();
        break;
      case "settings":
        openModal("settings");
        break;
      case "share":
        void navigator.clipboard?.writeText(shareLink(state)).then(
          () => flash(a, "Link copied"),
          () => flash(a, "Copy failed"),
        );
        break;
      case "close-modal":
        closeModal();
        break;
      case "close-insp":
        select(null);
        break;
      case "select":
        if (a.dataset.id) select(a.dataset.id);
        break;
      case "select-surplus":
      case "select-import":
        select(a.dataset.id ?? null);
        break;
      case "highlight-machine": {
        const step = result?.steps.filter((x) => x.machine?.name === a.dataset.machine).sort((x, y) => y.machines - x.machines)[0];
        if (step) select(step.id);
        break;
      }
      case "recipe": {
        const item = a.dataset.item!;
        const first = (pd.producers[item] ?? []).find((id) => !s.excluded.includes(id));
        if (recipe === first) delete s.recipeFor[item];
        else s.recipeFor[item] = recipe;
        s.excluded = s.excluded.filter((id) => id !== recipe);
        // Stay on the item: the inspector follows it to its new recipe.
        if (selected?.startsWith("step:")) selected = `step:${recipe}`;
        recompute();
        break;
      }
      case "import": {
        const item = a.dataset.item!;
        if (s.recipeFor[item] === "import") delete s.recipeFor[item];
        else s.recipeFor[item] = "import";
        if (selected?.startsWith("step:") && s.recipeFor[item] === "import") selected = `import:${item}`;
        recompute();
        break;
      }
      case "unimport":
        delete s.recipeFor[a.dataset.item!];
        recompute();
        break;
      case "machine":
        s.machineFor[recipe] = a.dataset.machine!;
        recompute();
        break;
      case "modfill": {
        const step = result?.steps.find((x) => x.recipe.id === recipe);
        if (!step?.machine) break;
        const mod = a.dataset.module ?? "";
        setModules(recipe, (setup) => {
          setup.modules = mod ? Array<string>(step.machine!.moduleSlots).fill(mod) : [];
        });
        break;
      }
      case "modslot": {
        const step = result?.steps.find((x) => x.recipe.id === recipe);
        if (!step?.machine) break;
        const slotIndex = Number(a.dataset.slot);
        const names = Object.keys(pd.modules).filter((n) => canUseModule(pd!, step.machine!, step.recipe, n));
        openPop(a, moduleChooserHtml(pd, names, step.modules[slotIndex] ?? ""), (value) => {
          setModules(recipe, (setup) => {
            const list = Array.from({ length: step.machine!.moduleSlots }, (_, i) => setup.modules[i] ?? "");
            list[slotIndex] = value;
            setup.modules = list.filter(Boolean);
          });
        });
        break;
      }
      case "beacons":
        setModules(recipe, (setup) => {
          setup.beacons = Math.max(0, Math.min(16, setup.beacons + Number(a.dataset.delta)));
          if (setup.beacons && !setup.beaconModule) setup.beaconModule = s.defaultBeaconModule;
        });
        break;
      case "beaconmod": {
        const names = Object.keys(pd.modules).filter((n) => n.startsWith("speed") || n.startsWith("efficiency"));
        const step = result?.steps.find((x) => x.recipe.id === recipe);
        openPop(a, moduleChooserHtml(pd, names, step?.beaconModule ?? ""), (value) => {
          setModules(recipe, (setup) => {
            setup.beaconModule = value;
            if (!value) setup.beacons = 0;
          });
        });
        break;
      }
      case "reset-step":
        delete s.machineFor[recipe];
        delete s.modulesFor[recipe];
        recompute();
        break;
      case "exclude":
        if (!s.excluded.includes(recipe)) s.excluded.push(recipe);
        selected = null;
        recompute();
        break;
      case "set": {
        const key = a.dataset.key!;
        const value = a.dataset.value ?? "";
        if (key === "belt") state.belt = value;
        else (s as unknown as Record<string, unknown>)[key] = value;
        recompute();
        renderModal();
        break;
      }
      case "default-beacons":
        s.defaultBeacons = Math.max(0, Math.min(16, s.defaultBeacons + Number(a.dataset.delta)));
        recompute();
        renderModal();
        break;
      case "research": {
        const key = a.dataset.key!;
        const level = Math.max(0, (s.research[key] ?? 0) + Number(a.dataset.delta));
        if (level) s.research[key] = level;
        else delete s.research[key];
        recompute();
        renderModal();
        break;
      }
      case "mining":
        s.miningProductivity = Math.max(0, s.miningProductivity + Number(a.dataset.delta));
        recompute();
        renderModal();
        break;
      case "reset-overrides":
        s.recipeFor = {};
        s.machineFor = {};
        s.modulesFor = {};
        s.excluded = [];
        recompute();
        renderModal();
        break;
    }
  }

  function onChange(ev: Event): void {
    const t = ev.target as HTMLInputElement;
    if (t.dataset.action === "toggle" && t.dataset.key === "preferSpaceAge") {
      state.settings.preferSpaceAge = t.checked;
      recompute();
      renderModal();
    }
  }

  let rateTimer = 0;
  function onInput(ev: Event): void {
    const t = ev.target as HTMLInputElement;
    if (t.classList.contains("pl-search")) {
      pickerQuery = t.value;
      renderModal();
      return;
    }
    if (t.closest(".pl-target-rate")) {
      const i = Number(t.dataset.index);
      const v = Number(t.value);
      if (!state.targets[i] || !Number.isFinite(v) || v < 0) return;
      state.targets[i]!.rate = v / UNIT_SECONDS[state.unit];
      clearTimeout(rateTimer);
      // Everything but the bar, so the input keeps its focus and caret.
      rateTimer = window.setTimeout(() => recompute({ keepBar: true }), 120);
    }
  }

  function onKey(ev: KeyboardEvent): void {
    if (ev.key === "Escape") {
      if (!pop.hidden) closePop();
      else if (!modal.hidden) closeModal();
      else if (selected) select(null);
      return;
    }
    const t = ev.target as HTMLInputElement;
    if (ev.key === "Enter" && t.classList.contains("pl-search")) {
      const first = modalBody.querySelector<HTMLElement>("[data-pick]");
      if (first && onPick) {
        const cb = onPick;
        closeModal();
        cb(first.dataset.pick!);
      }
    }
    if (ev.key === "Enter" && t.closest(".pl-target-rate")) {
      t.blur();
      recompute();
    }
  }

  function focusRate(i: number): void {
    requestAnimationFrame(() => {
      const input = targetsEl.querySelector<HTMLInputElement>(`input[data-index="${i}"]`);
      input?.focus();
      input?.select();
    });
  }

  function flash(anchor: HTMLElement, text: string): void {
    const span = anchor.querySelector("span");
    if (!span) return;
    const old = span.textContent;
    span.textContent = text;
    anchor.classList.add("is-flash");
    setTimeout(() => {
      span.textContent = old;
      anchor.classList.remove("is-flash");
    }, 1400);
  }

  const onOver = (ev: PointerEvent) => {
    if (ev.pointerType === "touch") return;
    const t = (ev.target as Element).closest?.("[data-tip]") as HTMLElement | null;
    if (t) showTip(t, ev.clientX, ev.clientY);
    else hideTip();
  };
  const onMove = (ev: PointerEvent) => moveTip(ev.clientX, ev.clientY);

  el.addEventListener("click", onClick);
  el.addEventListener("change", onChange);
  el.addEventListener("input", onInput);
  el.addEventListener("pointerdown", hideTip);
  el.addEventListener("pointerover", onOver);
  el.addEventListener("pointermove", onMove);
  el.addEventListener("pointerleave", hideTip);
  document.addEventListener("keydown", onKey);

  return () => {
    disposed = true;
    document.removeEventListener("keydown", onKey);
    root.innerHTML = "";
  };
}
