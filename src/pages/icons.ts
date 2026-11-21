import powerSvg from "../assets/icons/power.svg" with { type: "text" };
import waterSvg from "../assets/icons/water.svg" with { type: "text" };

export type UtilityKind = "power" | "water";

export const UTILITY_SVG: Record<UtilityKind, string> = {
  power: powerSvg.trim(),
  water: waterSvg.trim(),
};

export function utilityIconHtml(kind: UtilityKind, extraClass = ""): string {
  const cls = ["utility-icon", kind, extraClass].filter(Boolean).join(" ");
  return `<span class="${cls}" aria-hidden="true">${UTILITY_SVG[kind]}</span>`;
}

/** Populate `<span data-utility-icon="power|water">` placeholders in static HTML. */
export function hydrateUtilityIcons(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>("[data-utility-icon]").forEach((el) => {
    const kind = el.dataset.utilityIcon;
    if (kind !== "power" && kind !== "water") return;
    el.classList.add("utility-icon", kind);
    el.setAttribute("aria-hidden", "true");
    el.innerHTML = UTILITY_SVG[kind];
  });
}
