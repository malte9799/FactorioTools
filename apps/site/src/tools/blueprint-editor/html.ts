/** Escaping for markup built from blueprint-derived strings.
 *
 *  Everything a pasted blueprint carries — entity names, module names, recipe
 *  and machine labels, a book's own label — is attacker-controlled: blueprint
 *  strings are the community's normal exchange format and are routinely copied
 *  from strangers. Interpolated into `innerHTML` unescaped, a name like
 *  `<img src=x onerror=...>` becomes a live element, and a book label survives
 *  into localStorage and fires again on every later page load.
 *
 *  So: structure may be written as literal markup, but every interpolated
 *  value goes through `html` (or is set via textContent). The tagged-template
 *  form keeps the call sites readable — the existing template only gains an
 *  `html` prefix. */

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escapes the five characters that can break out of an HTML text node or a
 *  quoted attribute value. */
export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

/** Tagged template that escapes every interpolated value, leaving the literal
 *  markup around them untouched:
 *
 *  ```ts
 *  el.innerHTML = html`<span>${entityName}</span>`;
 *  ```
 *
 *  Use `raw()` for the rare interpolation that is itself already-escaped
 *  markup (e.g. a nested `html` result joined from a list). */
export function html(strings: TemplateStringsArray, ...values: unknown[]): string {
  let out = strings[0]!;
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    out += (value instanceof RawHtml ? value.value : escapeHtml(value)) + strings[i + 1]!;
  }
  return out;
}

class RawHtml {
  constructor(readonly value: string) {}
}

/** Marks a string as already-escaped markup so `html` inserts it verbatim.
 *  Only ever pass markup this module itself produced — never a raw
 *  blueprint-derived value, which is exactly what the escaping is for. */
export function raw(markup: string): RawHtml {
  return new RawHtml(markup);
}
