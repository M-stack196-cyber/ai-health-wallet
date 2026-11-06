// R8 accessibility scanner for the doctor and admin web apps (runs inside a Playwright page).
//
// Pass/fail rules here are objective structure checks. Colour contrast uses the published WCAG 2.2 AA
// figure (4.5:1 normal text, 3:1 large text) as a REFERENCE only: CFG-10 has no approved accessibility
// threshold yet, so this is a development check and not an approved acceptance value.
import type { Page } from "@playwright/test";

export interface A11yReport {
  issues: string[];
  checked: { fields: number; buttons: number; textElements: number; focusable: number };
  lowestContrast: number | null;
}

export async function scanAccessibility(page: Page): Promise<A11yReport> {
  const problems: string[] = [];
  // tsx adds a __name helper to compiled functions; the browser page does not have it.
  await page.evaluate("window.__name = window.__name || ((fn) => fn)");
  const report = await page.evaluate(() => {
    const issues: string[] = [];
    const describe = (el: Element) => {
      const text = (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
      return el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (text ? ' "' + text + '"' : "");
    };
    const visible = (el: Element) => {
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
      const box = el.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    };
    const textOf = (id: string) => (document.getElementById(id)?.textContent ?? "").trim();
    const nameOf = (el: Element): string => {
      const aria = el.getAttribute("aria-label")?.trim();
      if (aria) return aria;
      const by = el.getAttribute("aria-labelledby");
      if (by) {
        const joined = by.split(/\s+/).map(textOf).join(" ").trim();
        if (joined) return joined;
      }
      const labels = (el as HTMLInputElement).labels;
      if (labels && labels.length) {
        const joined = Array.from(labels).map(l => (l.textContent ?? "").trim()).join(" ").trim();
        if (joined) return joined;
      }
      const title = el.getAttribute("title")?.trim();
      if (title) return title;
      if (el.tagName === "INPUT" && ["button", "submit"].includes((el as HTMLInputElement).type)) return (el as HTMLInputElement).value;
      return (el.textContent ?? "").trim();
    };
    // Document level
    if (!document.documentElement.lang) issues.push("page has no language (html lang)");
    if (!document.title.trim()) issues.push("page has no title");
    const mains = document.querySelectorAll("main, [role=main]").length;
    if (mains !== 1) issues.push("expected exactly one main landmark, found " + mains);
    if (document.querySelectorAll("h1").length < 1) issues.push("page has no top-level heading");
    // Names
    const fields = Array.from(document.querySelectorAll("input, select, textarea")).filter(
      el => (el as HTMLInputElement).type !== "hidden" && visible(el));
    for (const el of fields) if (!nameOf(el)) issues.push("form field has no accessible name: " + describe(el));
    const buttons = Array.from(document.querySelectorAll("button, a[href], [role=button]")).filter(visible);
    for (const el of buttons) if (!nameOf(el)) issues.push("control has no accessible name: " + describe(el));
    for (const img of Array.from(document.querySelectorAll("img")).filter(visible)) {
      if (!img.hasAttribute("alt") && img.getAttribute("role") !== "presentation") issues.push("image has no alt text");
    }
    for (const svg of Array.from(document.querySelectorAll("svg[role=img]")).filter(visible)) {
      if (!nameOf(svg) && !svg.querySelector("title")) issues.push("svg image has no name");
    }
    for (const frame of Array.from(document.querySelectorAll("iframe")).filter(visible)) {
      if (!frame.getAttribute("title")) issues.push("frame has no title");
    }
    for (const el of Array.from(document.querySelectorAll("[tabindex]"))) {
      if (Number(el.getAttribute("tabindex")) > 0) issues.push("positive tabindex breaks natural keyboard order: " + describe(el));
    }
    // Duplicate ids make labels ambiguous
    const seen = new Set<string>();
    for (const el of Array.from(document.querySelectorAll("[id]"))) {
      if (seen.has(el.id)) issues.push("duplicate id: " + el.id);
      seen.add(el.id);
    }
    // Targets are not tiny (WCAG 2.2 AA minimum target is 24 CSS px).
    const focusable = Array.from(document.querySelectorAll<HTMLElement>(
      "button, a[href], input:not([type=hidden]), select, textarea, [tabindex]:not([tabindex='-1'])")).filter(
      el => visible(el) && !(el as HTMLButtonElement).disabled);
    for (const el of focusable) {
      const box = el.getBoundingClientRect();
      const inline = getComputedStyle(el).display === "inline" && el.tagName === "A";
      if (!inline && (box.width < 24 || box.height < 24)) issues.push("target smaller than 24x24 px: " + describe(el) + " " + Math.round(box.width) + "x" + Math.round(box.height));
    }
    // Colour contrast (reference WCAG 2.2 AA). Text over images/gradients is skipped, not guessed.
    const parse = (value: string): [number, number, number, number] | null => {
      const m = value.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
    };
    const lum = (r: number, g: number, b: number) => {
      const f = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const backdrop = (el: Element): [number, number, number] | null => {
      let layers: [number, number, number, number][] = [];
      for (let node: Element | null = el; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.backgroundImage !== "none") return null;
        const c = parse(style.backgroundColor);
        if (c && c[3] > 0) { layers.push(c); if (c[3] >= 1) break; }
      }
      let base: [number, number, number] = [255, 255, 255];
      for (const c of layers.reverse()) base = [0, 1, 2].map(i => c[i] * c[3] + base[i] * (1 - c[3])) as [number, number, number];
      return base;
    };
    let lowest: number | null = null, textElements = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const done = new Set<Element>();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || done.has(el) || !(n.textContent ?? "").trim() || !visible(el)) continue;
      if (["SCRIPT", "STYLE", "NOSCRIPT"].includes(el.tagName)) continue;
      if ((el as HTMLButtonElement).disabled || el.closest("[disabled]")) continue;
      done.add(el);
      const style = getComputedStyle(el);
      const fg = parse(style.color), bg = backdrop(el);
      if (!fg || !bg) continue;
      const a = fg[3];
      const blended = [0, 1, 2].map(i => fg[i] * a + bg[i] * (1 - a));
      const l1 = lum(blended[0], blended[1], blended[2]), l2 = lum(bg[0], bg[1], bg[2]);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      const size = parseFloat(style.fontSize), bold = Number(style.fontWeight) >= 700;
      const large = size >= 24 || (bold && size >= 18.66);
      textElements++;
      if (lowest === null || ratio < lowest) lowest = Math.round(ratio * 100) / 100;
      if (ratio < (large ? 3 : 4.5)) issues.push("low contrast " + (Math.round(ratio * 100) / 100) + ":1 (" + size + "px): " + describe(el));
    }
    return {
      issues: Array.from(new Set(issues)),
      checked: { fields: fields.length, buttons: buttons.length, textElements, focusable: focusable.length },
      lowestContrast: lowest,
    };
  });
  // Real keyboard walk: every stop must show a visible focus indicator (outline or shadow).
  await page.evaluate("document.activeElement && document.activeElement.blur && document.activeElement.blur()");
  const seen = new Set<string>();
  for (let i = 0; i < Math.min(report.checked.focusable + 2, 120); i++) {
    await page.keyboard.press("Tab");
    const stop = await page.evaluate(`(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const s = getComputedStyle(el);
      const text = (el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 40);
      return { id: el.tagName.toLowerCase() + ":" + text + ":" + Array.from(el.parentElement ? el.parentElement.children : []).indexOf(el),
        shown: (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== "none", label: el.tagName.toLowerCase() + ' "' + text + '"' };
    })()`) as { id: string; shown: boolean; label: string } | null;
    if (!stop) continue;
    if (seen.has(stop.id)) break;
    seen.add(stop.id);
    if (!stop.shown) problems.push("no visible keyboard focus indicator: " + stop.label);
  }
  report.issues.push(...problems);
  report.issues = Array.from(new Set(report.issues));
  return report;
}
