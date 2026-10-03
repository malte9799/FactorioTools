import type { PlacedEntity } from "@factoriotools/engine";

const ARITHMETIC: Record<string, string> = {
  "*": "multiply",
  "/": "divide",
  "+": "plus",
  "-": "minus",
  "%": "modulo",
  "^": "power",
  "<<": "left_shift",
  ">>": "right_shift",
  AND: "and",
  OR: "or",
  XOR: "xor",
};

const DECIDER: Record<string, string> = {
  ">": "greater",
  "<": "less",
  "=": "equal",
  "==": "equal",
  "≠": "not_equal",
  "!=": "not_equal",
  "≥": "greater_or_equal",
  ">=": "greater_or_equal",
  "≤": "less_or_equal",
  "<=": "less_or_equal",
};

const SELECTOR: Record<string, string> = {
  count: "count",
  random: "random",
  "stack-size": "stack_size",
  "rocket-capacity": "rocket_capacity",
  "quality-filter": "quality",
  "quality-transfer": "quality",
};

/** Which display symbol a combinator shows for the operation it is set to
 *  — the name of the prototype's own `<symbol>_symbol_sprites` set. The
 *  fallbacks are the blueprint format's defaults for an omitted field: "*"
 *  for an arithmetic combinator, "<" for a decider (which shows its first
 *  condition), "select" the maximum for a selector. */
export function combinatorSymbol(entity: PlacedEntity): string {
  const behavior = entity.controlBehavior;
  if (entity.name.includes("arithmetic")) {
    return ARITHMETIC[behavior?.arithmetic_conditions?.operation ?? "*"] ?? "multiply";
  }
  if (entity.name.includes("decider")) {
    return DECIDER[behavior?.decider_conditions?.conditions?.[0]?.comparator ?? "<"] ?? "less";
  }
  const operation = behavior?.operation ?? "select";
  if (operation === "select") return behavior?.select_max === false ? "min" : "max";
  return SELECTOR[operation] ?? "max";
}
