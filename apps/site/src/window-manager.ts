/** Turns an existing `.gui-window` element (titlebar + body, the markup the
 *  app already uses everywhere) into a real floating window: draggable by
 *  its titlebar, brought to front on interaction, clamped to stay partly
 *  on-screen. One generic utility applied to every floating panel rather
 *  than bespoke code per window — mirrors the drag/pointer-capture pattern
 *  already proven in packages/renderer/src/render.ts's pan handling. */

export interface FloatingWindowOptions {
  x: number;
  y: number;
  width?: number;
  /** Called when the titlebar's close (X) button is clicked, in addition to
   *  the window hiding itself — use this when closing needs to do more than
   *  just hide (e.g. the entity GUI also clearing the current selection).
   *  Optional: most windows only need the default hide behavior. */
  onClose?: () => void;
}

export interface FloatingWindow {
  el: HTMLElement;
  setPosition(x: number, y: number): void;
  bringToFront(): void;
  show(): void;
  hide(): void;
  destroy(): void;
}

let zCounter = 1000;

/** How much of a window must stay reachable at the viewport edge — same
 *  margin-clamp idea as the tooltip's positionTooltip(), applied
 *  continuously during drag instead of once at popup time. */
const EDGE_MARGIN = 24;

export function makeFloatingWindow(el: HTMLElement, options: FloatingWindowOptions): FloatingWindow {
  const titlebarEl = el.querySelector<HTMLElement>(".gui-titlebar");
  if (!titlebarEl) throw new Error("makeFloatingWindow: element has no .gui-titlebar to drag by");
  const titlebar: HTMLElement = titlebarEl;

  el.classList.add("floating-window");
  el.style.position = "fixed";
  if (options.width) el.style.width = `${options.width}px`;
  titlebar.style.cursor = "grab";

  // Every floating window gets a close (X) button injected into its
  // titlebar — per the user's own request, applied uniformly here rather
  // than duplicated in each window's own template markup.
  let closeButton = titlebar.querySelector<HTMLButtonElement>(".gui-close");
  if (!closeButton) {
    closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "gui-close";
    closeButton.setAttribute("aria-label", "Close");
    closeButton.textContent = "✕";
    titlebar.appendChild(closeButton);
  }
  const onCloseClick = (e: MouseEvent) => {
    e.stopPropagation();
    hide();
    options.onClose?.();
  };
  closeButton.addEventListener("click", onCloseClick);
  // The titlebar's own pointerdown starts a drag and captures the pointer,
  // which swallows the click a press-on-the-button would otherwise produce
  // (the browser resolves the synthetic click against whichever element has
  // capture, not the button itself) — stop it here before it bubbles there.
  const onCloseButtonPointerDown = (e: PointerEvent) => e.stopPropagation();
  closeButton.addEventListener("pointerdown", onCloseButtonPointerDown);

  let x = options.x;
  let y = options.y;
  let dragging = false;
  let startPointer = { x: 0, y: 0 };
  let startWindow = { x: 0, y: 0 };
  let destroyed = false;

  function apply(): void {
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }

  function clampToViewport(): void {
    const rect = el.getBoundingClientRect();
    const maxX = window.innerWidth - EDGE_MARGIN;
    const maxY = window.innerHeight - EDGE_MARGIN;
    x = Math.min(Math.max(x, EDGE_MARGIN - rect.width), maxX);
    y = Math.min(Math.max(y, 0), maxY);
  }

  function bringToFront(): void {
    zCounter += 1;
    el.style.zIndex = String(zCounter);
  }

  /** On opening, moves a window that fits on screen fully into view and
   *  below the toolbar strip. Starting positions are picked for a desktop;
   *  on a phone a window placed "near the right edge" would otherwise open
   *  mostly off-screen, or with its titlebar under the toolbar. */
  function fitOnScreen(): void {
    const rect = el.getBoundingClientRect();
    const margin = 8;
    const toolbar = document.getElementById("window-toolbar")?.getBoundingClientRect();
    const minY = toolbar && toolbar.height > 0 ? toolbar.bottom + 6 : 0;
    x = rect.width + 2 * margin <= window.innerWidth ? Math.min(Math.max(x, margin), window.innerWidth - rect.width - margin) : margin;
    y = Math.max(minY, Math.min(y, window.innerHeight - rect.height - margin));
    apply();
  }

  function show(): void {
    el.hidden = false;
    fitOnScreen();
  }

  function hide(): void {
    el.hidden = true;
  }

  function onPointerDownRaise(): void {
    bringToFront();
  }

  function onTitlebarPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    dragging = true;
    startPointer = { x: e.clientX, y: e.clientY };
    startWindow = { x, y };
    titlebar.setPointerCapture(e.pointerId);
    titlebar.style.cursor = "grabbing";
    bringToFront();
  }

  function onTitlebarPointerMove(e: PointerEvent): void {
    if (!dragging) return;
    x = startWindow.x + (e.clientX - startPointer.x);
    y = startWindow.y + (e.clientY - startPointer.y);
    clampToViewport();
    apply();
  }

  function onTitlebarPointerUp(e: PointerEvent): void {
    if (!dragging) return;
    dragging = false;
    titlebar.style.cursor = "grab";
    try {
      titlebar.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  }

  el.addEventListener("pointerdown", onPointerDownRaise);
  titlebar.addEventListener("pointerdown", onTitlebarPointerDown);
  titlebar.addEventListener("pointermove", onTitlebarPointerMove);
  titlebar.addEventListener("pointerup", onTitlebarPointerUp);
  titlebar.addEventListener("pointercancel", onTitlebarPointerUp);

  bringToFront();
  apply();

  return {
    el,
    setPosition(nx, ny) {
      x = nx;
      y = ny;
      clampToViewport();
      apply();
    },
    bringToFront,
    show,
    hide,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      closeButton.removeEventListener("click", onCloseClick);
      closeButton.removeEventListener("pointerdown", onCloseButtonPointerDown);
      el.removeEventListener("pointerdown", onPointerDownRaise);
      titlebar.removeEventListener("pointerdown", onTitlebarPointerDown);
      titlebar.removeEventListener("pointermove", onTitlebarPointerMove);
      titlebar.removeEventListener("pointerup", onTitlebarPointerUp);
      titlebar.removeEventListener("pointercancel", onTitlebarPointerUp);
    },
  };
}
