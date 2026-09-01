import type { QualityName } from "@factoriotools/engine";

/** The 5-tier quality list, in order — used everywhere a quality `<select>`
 *  is built (inserter measure picker, entity properties panel, module slot
 *  pickers) so it's defined once instead of duplicated per call site. */
export const QUALITY_TIERS: QualityName[] = ["normal", "uncommon", "rare", "epic", "legendary"];

export function appendQualityOptions(select: HTMLSelectElement): void {
  for (const tier of QUALITY_TIERS) {
    select.appendChild(new Option(tier, tier));
  }
}
