// report.html: the brief as one self-contained page (inline CSS and SVG, no scripts,
// no external resources). It renders only what report.json holds; nothing is computed
// or reordered here. Styling follows the spec: white background, #007F6E headers,
// #BFDFDB table stripes, #02040A text, Arial.

import type { ReportJson } from "./build.ts";
import { fpcaSvg } from "./svg.ts";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const f = (x: number | null | undefined, d = 2): string => {
  if (x === null || x === undefined || !Number.isFinite(x)) return "–";
  const a = Math.abs(x);
  if (a !== 0 && (a >= 1e6 || a < 1e-3)) return x.toExponential(2);
  return x.toFixed(a >= 100 ? 0 : d);
};
const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
const px = (x: number) => (Math.round(x * 10) / 10).toString();

const C = { ink: "#02040A", ink2: "#46525E", ink3: "#6E7883", accent: "#007F6E", stripe: "#BFDFDB", rule: "#D6E4E2", paper: "#FFFFFF", warn: "#9A5B00", bad: "#B42318", gray: "#A3ACB5" };

export const STYLE = `
/* Layout: one reading column (max 1040px) of six numbered sections, in the spec's fixed order; wide tables scroll inside their own frames. */
:root {
  --paper: ${C.paper};
  --ink: ${C.ink};
  --ink-2: ${C.ink2};
  --ink-3: ${C.ink3};
  --accent: ${C.accent};
  --stripe: ${C.stripe};
  --rule: ${C.rule};
  --warn: ${C.warn};
  --bad: ${C.bad};
  --font: Arial, "Helvetica Neue", Helvetica, sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --step--1: 0.8125rem;
  --step-0: 0.9375rem;
  --step-1: 1.125rem;
  --step-2: 1.5rem;
  --step-3: 2rem;
}
body { background: var(--paper); color: var(--ink); font-family: var(--font); font-size: var(--step-0); line-height: 1.5; margin: 0; }
.page { max-width: 1040px; margin: 0 auto; padding-block: 28px 56px; padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); display: grid; gap: 36px; }
header.brief { display: grid; gap: 10px; border-bottom: 2px solid var(--accent); padding-bottom: 18px; }
.eyebrow { font-size: var(--step--1); letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-2); }
h1 { font-size: var(--step-3); line-height: 1.15; margin: 0; color: var(--accent); text-wrap: balance; }
h2 { font-size: var(--step-2); line-height: 1.2; margin: 0; color: var(--accent); text-wrap: balance; display: flex; gap: 10px; align-items: baseline; }
h2 .num { font-size: var(--step-1); color: var(--ink-3); font-variant-numeric: tabular-nums; }
h3 { font-size: var(--step-1); margin: 0; color: var(--accent); }
p { margin: 0; max-width: 72ch; }
section { display: grid; gap: 16px; min-width: 0; }
.meta { display: flex; flex-wrap: wrap; gap: 6px 18px; color: var(--ink-2); font-size: var(--step--1); }
.meta b { color: var(--ink); font-weight: 700; }
.notice { font-size: var(--step--1); color: var(--ink-2); border-left: 3px solid var(--stripe); padding-left: 10px; }
.explain { border: 1px solid var(--rule); border-radius: 6px; padding: 12px 14px; display: grid; gap: 6px; max-width: 80ch; }
.explain .who { font-size: var(--step--1); color: var(--ink-3); }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(290px, 1fr)); gap: 16px; }
.card { border: 1px solid var(--rule); border-radius: 8px; padding: 16px; display: grid; gap: 12px; min-width: 0; align-content: start; }
.card.top { border-color: var(--accent); }
.rank { font-size: var(--step--1); color: var(--ink-3); letter-spacing: 0.04em; text-transform: uppercase; }
.picks { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { display: inline-flex; gap: 4px; align-items: baseline; border: 1px solid var(--rule); border-radius: 999px; padding: 1px 9px; font-size: var(--step--1); white-space: nowrap; }
.chip span { color: var(--ink-3); }
.figures { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.figure .label { font-size: var(--step--1); color: var(--ink-2); }
.figure .value { font-size: var(--step-2); font-weight: 700; line-height: 1.1; }
.figure .sub { font-size: var(--step--1); color: var(--ink-3); font-variant-numeric: tabular-nums; }
.scroll { overflow-x: auto; min-width: 0; }
table { border-collapse: collapse; width: 100%; font-size: var(--step--1); font-variant-numeric: tabular-nums; }
th { text-align: left; color: var(--accent); font-weight: 700; border-bottom: 2px solid var(--accent); padding: 6px 8px; white-space: nowrap; }
td { padding: 6px 8px; border-bottom: 1px solid var(--rule); vertical-align: middle; }
tbody tr:nth-child(even) td { background: var(--stripe); }
td.num, th.num { text-align: right; }
code, .id { font-family: var(--mono); font-size: 0.92em; overflow-wrap: anywhere; }
.pill { display: inline-block; border-radius: 999px; padding: 0 8px; font-size: var(--step--1); font-weight: 700; white-space: nowrap; }
.pill.bind { background: var(--accent); color: var(--paper); }
.pill.slack { border: 1px solid var(--ink-3); color: var(--ink-2); }
.pill.warn { border: 1px solid var(--warn); color: var(--warn); }
.pill.bad { border: 1px solid var(--bad); color: var(--bad); }
.charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 20px; }
figure { margin: 0; display: grid; gap: 6px; min-width: 0; }
figcaption { font-size: var(--step--1); color: var(--ink-2); max-width: 72ch; }
svg { max-width: 100%; height: auto; display: block; }
ul.plain { margin: 0; padding-left: 18px; display: grid; gap: 4px; }
footer { font-size: var(--step--1); color: var(--ink-3); border-top: 1px solid var(--rule); padding-top: 12px; }
@media (max-width: 480px) { h1 { font-size: 1.6rem; } .figures { grid-template-columns: 1fr 1fr; } }
`;

function explanation(r: ReportJson, key: "recommended" | "solution_map" | "requirements" | "ledger" | "next_measurements"): string {
  const t = r.explanations?.texts[key];
  if (!t) return "";
  return `<div class="explain"><div class="who">Explanation written by ${esc(r.explanations!.model)}; every number in it was filled in by code.</div><p>${esc(t)}</p></div>`;
}

/** Slack bands (q05–q95, median tick) for one candidate; the zone edge is slack 0. */
function marginChart(metrics: ReportJson["recommended"][number]["metrics"]): string {
  const W = 340;
  const rowH = 26;
  const L = 112;
  const R = 12;
  const T = 18;
  const H = T + metrics.length * rowH + 22;
  const lo = -1;
  const hi = 1;
  const x = (s: number) => L + ((Math.max(lo, Math.min(hi, s)) - lo) / (hi - lo)) * (W - L - R);
  const out: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" font-family="Arial, Helvetica, sans-serif" viewBox="0 0 ${W} ${H}" role="img" aria-label="Constraint margins">`];
  for (const t of [-1, -0.5, 0, 0.5, 1]) {
    out.push(`<line x1="${px(x(t))}" y1="${T - 4}" x2="${px(x(t))}" y2="${H - 20}" stroke="${t === 0 ? C.accent : C.rule}" stroke-width="1"/>`);
    out.push(`<text x="${px(x(t))}" y="${H - 6}" font-size="10" text-anchor="middle" fill="${C.ink2}">${t}</text>`);
  }
  out.push(`<text x="${px(x(0) + 4)}" y="${T - 6}" font-size="10" fill="${C.accent}">zone edge</text>`);
  metrics.forEach((m, i) => {
    const y = T + i * rowH + rowH / 2;
    const [a, b, c] = m.slack_q;
    out.push(`<text x="${L - 8}" y="${px(y + 4)}" font-size="11" text-anchor="end" fill="${C.ink}">${esc(m.root)}</text>`);
    out.push(`<g><title>${esc(m.root)}: slack q05 ${f(a)}, median ${f(b)}, q95 ${f(c)} (metric q50 ${f(m.q[1])}${m.unit ? ` ${esc(m.unit)}` : ""})</title>`);
    out.push(`<rect x="${px(x(a))}" y="${px(y - 6)}" width="${px(Math.max(2, x(c) - x(a)))}" height="12" rx="4" fill="${C.stripe}"/>`);
    out.push(`<rect x="${px(x(b) - 1.5)}" y="${px(y - 8)}" width="3" height="16" rx="1.5" fill="${a < 0 ? C.bad : C.accent}"/></g>`);
  });
  out.push(`</svg>`);
  return out.join("");
}

/** Prior (light) and posterior (accent) 90% intervals on one shared scale. */
function intervalBar(prior: number[], post: number[]): string {
  const W = 132;
  const H = 18;
  const lo = Math.min(prior[0], post[0]);
  const hi = Math.max(prior[2], post[2]);
  const span = hi - lo || 1;
  const x = (v: number) => 4 + ((v - lo) / span) * (W - 8);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" font-family="Arial, Helvetica, sans-serif" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="prior and posterior intervals">` +
    `<title>prior 90%: ${f(prior[0])} to ${f(prior[2])}; posterior 90%: ${f(post[0])} to ${f(post[2])}, median ${f(post[1])}</title>` +
    `<rect x="${px(x(prior[0]))}" y="3" width="${px(Math.max(2, x(prior[2]) - x(prior[0])))}" height="5" rx="2.5" fill="${C.stripe}"/>` +
    `<rect x="${px(x(post[0]))}" y="10" width="${px(Math.max(2, x(post[2]) - x(post[0])))}" height="5" rx="2.5" fill="${C.accent}"/>` +
    `<rect x="${px(x(post[1]) - 1)}" y="8" width="2" height="9" fill="${C.ink}"/></svg>`
  );
}

/** Mean P(in zone) per family along the volume axis; the family holding the pick is drawn in the accent. */
function familyChart(r: ReportJson): string {
  const m = r.solution_map;
  const W = 520;
  const H = 300;
  const L = 44;
  const Rm = 64;
  const T = 26;
  const B = 40;
  const lx = m.multipliers.map((v) => Math.log2(v));
  const x0 = Math.min(...lx);
  const x1 = Math.max(...lx);
  const x = (v: number) => L + ((Math.log2(v) - x0) / (x1 - x0 || 1)) * (W - L - Rm);
  const y = (p: number) => T + (1 - p) * (H - T - B);
  const out: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" font-family="Arial, Helvetica, sans-serif" viewBox="0 0 ${W} ${H}" role="img" aria-label="P(in zone) by family along the volume axis">`];
  for (const p of [0, 0.25, 0.5, 0.75, 1]) {
    out.push(`<line x1="${L}" y1="${px(y(p))}" x2="${W - Rm}" y2="${px(y(p))}" stroke="${C.rule}" stroke-width="1"/>`);
    out.push(`<text x="${L - 6}" y="${px(y(p) + 4)}" font-size="10" text-anchor="end" fill="${C.ink2}">${p}</text>`);
  }
  for (const v of m.multipliers) out.push(`<text x="${px(x(v))}" y="${H - B + 16}" font-size="10" text-anchor="middle" fill="${C.ink2}">${v}×</text>`);
  out.push(`<text x="${px((L + W - Rm) / 2)}" y="${H - 6}" font-size="11" text-anchor="middle" fill="${C.ink}">peak volume, multiple of today's estimate</text>`);
  out.push(`<line x1="${L}" y1="${px(y(r.settings.tau))}" x2="${W - Rm}" y2="${px(y(r.settings.tau))}" stroke="${C.ink3}" stroke-width="1"/>`);
  out.push(`<text x="${W - Rm + 6}" y="${px(y(r.settings.tau) + 4)}" font-size="10" fill="${C.ink2}">τ = ${r.settings.tau}</text>`);
  const fams = [...m.families].sort((a, b) => Number(a.in_goldilocks) - Number(b.in_goldilocks) || a.id - b.id);
  for (const fam of fams) {
    const color = fam.in_goldilocks ? C.accent : C.gray;
    const pts = fam.mean_curve.map((p, k) => `${px(x(m.multipliers[k]))},${px(y(p))}`).join(" ");
    out.push(`<g><title>F${fam.id + 1} (${fam.members.length} candidates${fam.in_goldilocks ? ", contains the pick" : `, rejected; most binding ${fam.most_binding}`}): ${fam.mean_curve.map((p) => f(p)).join(" → ")}</title>`);
    out.push(`<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="${fam.in_goldilocks ? 3 : 2}" stroke-linejoin="round" stroke-linecap="round"/>`);
    const last = fam.mean_curve.length - 1;
    out.push(`<circle cx="${px(x(m.multipliers[last]))}" cy="${px(y(fam.mean_curve[last]))}" r="4" fill="${color}" stroke="${C.paper}" stroke-width="2"/></g>`);
  }
  // Direct label for the pick's family only; the legend below names the rest.
  const g = m.families.find((fam) => fam.in_goldilocks);
  if (g) out.push(`<text x="${px(x(m.multipliers[0]) + 4)}" y="${px(y(g.mean_curve[0]) - 8)}" font-size="11" font-weight="700" fill="${C.ink}">F${g.id + 1}: holds the pick</text>`);
  out.push(`</svg>`);
  return out.join("");
}

/** Best EVPPI/cost per iteration against the stop threshold of 1. */
function trajectoryChart(r: ReportJson): string {
  const h = r.history;
  const W = 520;
  const H = 230;
  const L = 44;
  const Rm = 16;
  const T = 16;
  const B = 44;
  const top = Math.max(1.5, ...h.map((e) => e.max_score)) * 1.1;
  const x = (i: number) => L + (h.length === 1 ? 0.5 : i / (h.length - 1)) * (W - L - Rm);
  const y = (v: number) => T + (1 - v / top) * (H - T - B);
  const out: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" font-family="Arial, Helvetica, sans-serif" viewBox="0 0 ${W} ${H}" role="img" aria-label="Best value of information per dollar by iteration">`];
  const ticks = [0, 1, ...[2, 4, 6, 8, 10, 15, 20].filter((t) => t < top)];
  for (const t of ticks) {
    out.push(`<line x1="${L}" y1="${px(y(t))}" x2="${W - Rm}" y2="${px(y(t))}" stroke="${t === 1 ? C.ink3 : C.rule}" stroke-width="1"/>`);
    out.push(`<text x="${L - 6}" y="${px(y(t) + 4)}" font-size="10" text-anchor="end" fill="${C.ink2}">${t}</text>`);
  }
  out.push(`<text x="${W - Rm}" y="${px(y(1) - 6)}" font-size="10" text-anchor="end" fill="${C.ink2}">stop below 1</text>`);
  out.push(`<polyline points="${h.map((e, i) => `${px(x(i))},${px(y(e.max_score))}`).join(" ")}" fill="none" stroke="${C.accent}" stroke-width="2" stroke-linejoin="round"/>`);
  const short = { init: "start", measure: "measure", expand: "expand", hold: "hold" } as const;
  h.forEach((e, i) => {
    out.push(`<g><title>iteration ${e.iter}: ${e.action.kind}${e.action.node ? ` ${e.action.node}` : ""}; best EVPPI/cost ${f(e.max_score)}; G has ${e.G.length}</title>`);
    out.push(`<circle cx="${px(x(i))}" cy="${px(y(e.max_score))}" r="4.5" fill="${e.action.kind === "expand" ? C.paper : C.accent}" stroke="${C.accent}" stroke-width="2"/></g>`);
    out.push(`<text x="${px(x(i))}" y="${H - B + 16}" font-size="10" text-anchor="middle" fill="${C.ink2}">${e.iter}</text>`);
    out.push(`<text x="${px(x(i))}" y="${H - B + 30}" font-size="9" text-anchor="middle" fill="${C.ink3}">${short[e.action.kind]}</text>`);
  });
  out.push(`</svg>`);
  return out.join("");
}

function table(head: string[], rows: string[][], numeric: number[] = []): string {
  const th = head.map((h, i) => `<th${numeric.includes(i) ? ' class="num"' : ""}>${h}</th>`).join("");
  const body = rows.map((r) => `<tr>${r.map((c, i) => `<td${numeric.includes(i) ? ' class="num"' : ""}>${c}</td>`).join("")}</tr>`).join("");
  return `<div class="scroll"><table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`;
}

export function reportHtmlBody(r: ReportJson, title: string): string {
  const s = r.settings;
  const o: string[] = [];
  o.push(`<title>${esc(title)}</title>`);
  o.push(`<meta name="claude:viewport-fit-sides" content="cover">`);
  o.push(`<style>${STYLE}</style>`);
  o.push(`<div class="page">`);
  o.push(`<header class="brief"><div class="eyebrow">Goldilocks decision brief</div><h1>${esc(r.title)}</h1>`);
  o.push(
    `<div class="meta"><span>Status <b>${esc(r.status)}</b> after iteration <b>${r.iteration}</b></span><span>τ <b>${s.tau}</b></span><span>ε <b>${s.epsilon}</b></span><span>β <b>${s.beta}</b></span><span><b>${s.particles}</b> particles (ESS ${f(s.ess, 0)})</span><span>zone rule <b>${esc(s.zone_rule)}</b></span></div>`,
  );
  o.push(`<p class="notice">Every input number in this run is illustrative fixture data, and every option is a generic architecture pattern, not a vendor. All figures below are computed by code; text written by a language model is labelled.</p></header>`);

  // 1. Recommended
  o.push(`<section id="recommended"><h2><span class="num">1</span>Recommended solutions</h2>`);
  o.push(explanation(r, "recommended"));
  if (r.recommended.length === 0) o.push(`<p>No candidate reaches the zone with probability ${s.tau}. Section 3 lists the smallest relaxations that would admit one.</p>`);
  o.push(`<div class="cards">`);
  r.recommended.forEach((rec, i) => {
    const picks = Object.entries(rec.picks).map(([d, v]) => `<span class="chip"><span>${esc(d)}</span>${esc(v)}</span>`).join("");
    o.push(`<article class="card${i === 0 ? " top" : ""}"><div class="rank">${i === 0 ? "Recommended" : `Alternative ${i}`}</div><div class="id">${esc(rec.id)}</div><div class="picks">${picks}</div>`);
    o.push(
      `<div class="figures"><div class="figure"><div class="label">P(in zone)</div><div class="value">${f(rec.p_zone, 3)}</div><div class="sub">90% MC interval ${f(rec.p_interval[0], 3)}–${f(rec.p_interval[1], 3)}</div></div>` +
        `<div class="figure"><div class="label">Spend, USD/month</div><div class="value">${f(rec.cost_q[1], 0)}</div><div class="sub">q05–q95 ${f(rec.cost_q[0], 0)}–${f(rec.cost_q[2], 0)}</div></div></div>`,
    );
    o.push(`<figure>${marginChart(rec.metrics)}<figcaption>Margin to each requirement as slack: 1 is at or better than target, 0 is the edge of the band, below 0 misses it. Bars span the 5th–95th percentile; the tick is the median.</figcaption></figure>`);
    o.push(table(["root", "metric q05 / q50 / q95", "unit"], rec.metrics.map((m) => [esc(m.root), `${f(m.q[0])} / ${f(m.q[1])} / ${f(m.q[2])}`, esc(m.unit ?? "")])));
    o.push(`</article>`);
  });
  o.push(`</div>`);
  o.push(`<p>Goldilocks set: ${r.goldilocks.G.length} candidate${r.goldilocks.G.length === 1 ? "" : "s"} (${r.goldilocks.G.map((g) => `<code>${esc(g)}</code>`).join(", ") || "none"}). ${r.goldilocks.qualified} candidates reach P ≥ ${s.tau}; the cheapest costs ${f(r.goldilocks.cheapest_cost, 0)} USD/month, and the set keeps those within ${pct(s.epsilon)} of it.</p>`);
  o.push(`</section>`);

  // 2. Solution map
  const m = r.solution_map;
  o.push(`<section id="map"><h2><span class="num">2</span>Solution map</h2>`);
  o.push(explanation(r, "solution_map"));
  o.push(`<div class="charts"><figure>${fpcaSvg(r)}<figcaption>Each mark is a candidate, placed by the first two functional principal components of its P(in zone) curve along the volume axis (${m.fpca.explained.map(pct).join(" and ")} of the variance). Shape is the family; filled marks are in the Goldilocks set.</figcaption></figure>`);
  o.push(`<figure>${familyChart(r)}<figcaption>Mean P(in zone) for each family as peak volume grows. The highlighted family holds the pick; grey lines are rejected families (hover for names). The horizontal line is τ.</figcaption></figure></div>`);
  o.push(
    table(
      ["family", "members", "status", "most-binding constraint", "mean P along the axis"],
      m.families.map((fam) => [`F${fam.id + 1}`, String(fam.members.length), fam.in_goldilocks ? `<span class="pill bind">holds the pick</span>` : `<span class="pill slack">rejected</span>`, esc(fam.most_binding ?? "–"), fam.mean_curve.map((v) => f(v)).join(" → ")]),
      [1],
    ),
  );
  o.push(`</section>`);

  // 3. Minimum requirements
  o.push(`<section id="requirements"><h2><span class="num">3</span>Minimum requirements</h2>`);
  o.push(explanation(r, "requirements"));
  o.push(
    table(
      ["root", "band", "weight", "source", "status", `relaxing by ${r.requirements.relaxations[0]?.step ?? 0.25} slack admits`, "cheapest after", "restores G at"],
      r.requirements.relaxations.map((x) => {
        const root = r.requirements.roots.find((y) => y.id === x.root)!;
        const band = root.sense === "upper" ? `≤ ${root.upper} (target ${root.target})` : root.sense === "lower" ? `≥ ${root.lower} (target ${root.target})` : `${root.lower} to ${root.upper}`;
        return [
          esc(x.root),
          esc(band),
          f(root.weight),
          esc(root.source),
          x.binding ? `<span class="pill bind">binding</span>` : `<span class="pill slack">slack</span>`,
          x.admits.length ? `${x.admits.length}: ${x.admits.slice(0, 2).map((a) => `<code>${esc(a)}</code>`).join(", ")}${x.admits.length > 2 ? " …" : ""}` : "none",
          f(x.cheapest_after, 0),
          x.restore_metric === null ? "–" : `+${f(x.restore_metric)}`,
        ];
      }),
      [2, 6],
    ),
  );
  if (r.requirements.conflicts.length) o.push(`<p><span class="pill bad">conflict</span> ${r.requirements.conflicts.map(([a, b]) => `${esc(a)} × ${esc(b)}`).join("; ")}: neither relaxation alone restores a non-empty set; both together do.</p>`);
  const risk = r.upward.filter((u) => u.at_risk);
  o.push(
    risk.length
      ? `<ul class="plain">${risk.map((u) => `<li><span class="pill warn">at risk</span> ${esc(u.root)}: the best candidate meets it with probability ${f(u.best_p, 3)}; culprits ${u.culprits.map((c) => `${esc(c.node)} (${pct(c.mass_outside)} of posterior mass outside the range the root implies)`).join(", ")}${u.restore_delta === null ? "" : `; relaxing it by ${f(u.restore_delta)} slack units restores it`}.</li>`).join("")}</ul>`
      : `<p>No root is at risk from upward evidence: each one can be met on its own with probability ≥ ${s.tau}.</p>`,
  );
  o.push(`</section>`);

  // 4. Ledger
  o.push(`<section id="ledger"><h2><span class="num">4</span>Parameter ledger</h2>`);
  o.push(explanation(r, "ledger"));
  o.push(
    table(
      ["parameter", "source", "measured", "prior → posterior (90%)", "posterior q05 / q50 / q95", "EVPPI, USD", "EVPPI/cost"],
      r.ledger.map((l) => [
        `<span class="id">${esc(l.id)}</span>`,
        l.source === "llm_guess" ? `<span class="pill warn">llm_guess</span>` : esc(l.source),
        l.measured ? `${l.measured}×` : l.observable ? "not yet" : "not observable",
        intervalBar(l.prior_q, l.posterior_q),
        `${f(l.posterior_q[0])} / ${f(l.posterior_q[1])} / ${f(l.posterior_q[2])}`,
        f(l.evppi, 0),
        f(l.score),
      ]),
      [5, 6],
    ),
  );
  const g = r.llm_guess;
  o.push(`<h3>How much the answer leans on llm_guess priors</h3>`);
  o.push(`<p>${g.nodes.length} parameters rest on llm_guess priors and carry ${pct(g.evppi_share)} of the remaining value of information. Reweighting the posterior under alternative priors for them:</p>`);
  o.push(table(["scenario", "effective sample", "recommendation", "overlap with current set (Jaccard)", "P(current pick)"], g.cases.map((c) => [esc(c.scenario), f(c.ess, 0), c.recommended[0] ? `<code>${esc(c.recommended[0])}</code>` : "none", f(c.jaccard_vs_base), f(c.p_of_base_pick, 3)]), [1, 3, 4]));
  o.push(`</section>`);

  // 5. Next measurements
  o.push(`<section id="next"><h2><span class="num">5</span>Next measurements</h2>`);
  o.push(explanation(r, "next_measurements"));
  o.push(
    r.next_measurements.length
      ? table(["parameter", "action", "EVPPI, USD", "cost, USD", "EVPPI/cost"], r.next_measurements.map((x) => [`<span class="id">${esc(x.node)}</span>`, esc(x.action), f(x.evppi, 0), f(x.cost, 0), f(x.score)]), [2, 3, 4])
      : `<p>No measurement is worth its cost now: the best value of information per dollar is below 1, so the engine stopped.</p>`,
  );
  o.push(`<figure>${trajectoryChart(r)}<figcaption>Best value of information per dollar at each iteration, with the action taken next. Hollow points are expansions. The run stops once this stays below 1 and the Goldilocks set stops changing for two iterations.</figcaption></figure>`);
  o.push(
    r.flips.length
      ? `<h3>What would flip the recommendation</h3><ul class="plain">${r.flips.map((fl) => `<li>If <span class="id">${esc(fl.node)}</span> is between ${f(fl.lo)} and ${f(fl.hi)} (${pct(fl.mass)} of posterior mass), the pick becomes ${fl.pick ? `<code>${esc(fl.pick)}</code>` : "nothing (empty set)"}.</li>`).join("")}</ul>`
      : `<p>No plausible value of a remaining parameter changes the recommendation.</p>`,
  );
  o.push(`</section>`);

  // 6. Audit
  const a = r.audit;
  o.push(`<section id="audit"><h2><span class="num">6</span>Audit trail</h2>`);
  o.push(`<ul class="plain"><li>Run <code>${esc(a.run_id)}</code></li><li>Manifest SHA-256 <code>${esc(a.manifest_sha256)}</code></li><li>Event log: <code>${esc(a.events)}</code> (one line per approve, measure, expand, update, evaluate and plan step, each with input and output hashes)</li><li>Final snapshot: <code>${esc(a.final_snapshot)}</code></li></ul>`);
  if (r.approvals?.length)
    o.push(`<h3>Approvals</h3>` + table(["what", "approved by", "when", "bound to content"], r.approvals.map((p) => [esc(p.what), esc(p.approved_by), esc(p.approved_at ?? "–"), p.bound ? `<code>${esc(p.bound.slice(0, 16))}…</code>` : "no (fixture record)"])));
  o.push(`<h3>Iterations</h3>`);
  o.push(table(["iteration", "action", "parameter", "G size", "Jaccard with previous", "best EVPPI/cost"], r.history.map((h) => [String(h.iter), esc(h.action.kind), h.action.node ? `<span class="id">${esc(h.action.node)}</span>` : "–", String(h.G.length), f(h.jaccard), f(h.max_score)]), [0, 3, 4, 5]));
  const ag = r.agents;
  if (ag.decompositions.length || ag.options.length)
    o.push(`<h3>Accepted agent proposals</h3><ul class="plain">${ag.decompositions.map((d) => `<li>Decomposition of <span class="id">${esc(d.parent)}</span> into ${d.children.map((c) => `<span class="id">${esc(c.id)}</span>`).join(", ")}</li>`).join("")}${ag.options.map((p) => `<li>Hybrid option <span class="id">${esc(p.option.id)}</span> in ${esc(p.dimension)}, a variant of ${esc(p.based_on)}</li>`).join("")}</ul>`);
  if (r.advice) {
    const adv = r.advice;
    o.push(`<h3>Critic advice</h3><div class="explain"><div class="who">Written by ${esc(adv.model)} at iteration ${adv.iter}. Advisory only: it cannot change any result.</div><p>${esc(adv.advice.summary)}</p>${adv.advice.concerns.length ? `<ul class="plain">${adv.advice.concerns.map((c) => `<li><b>${esc(c.flag)}</b>: ${esc(c.explanation)} ${esc(c.suggestion)}</li>`).join("")}</ul>` : ""}</div>`);
  }
  if (r.flags.length) o.push(`<h3>Critic flags</h3><ul class="plain">${r.flags.map((fl) => `<li><span class="pill ${fl.severity === "error" ? "bad" : "warn"}">${esc(fl.severity)}</span> ${esc(fl.message)}</li>`).join("")}</ul>`);
  o.push(`</section>`);
  o.push(`<footer>Generated by the Goldilocks Discovery Engine from report.json. Language models propose and explain; code scores, ranks, updates and selects.</footer>`);
  o.push(`</div>`);
  return o.join("\n");
}

/** Full standalone document for the run folder. */
export function reportHtmlDocument(r: ReportJson, title: string): string {
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n${reportHtmlBody(r, title)
    .replace(/^(<title>[\s\S]*?<\/style>)/, "$1\n</head>\n<body>")}\n</body>\n</html>\n`;
}
