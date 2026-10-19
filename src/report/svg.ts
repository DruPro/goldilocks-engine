// FPCA scatter as a standalone SVG (no libraries). Marker shape = family;
// fill = status (Goldilocks member, otherwise rejected). Palette per the brief:
// white background, #007F6E accent, #BFDFDB light accent, #02040A text, Arial.

import type { ReportJson } from "./build.ts";

const INK = "#02040A";
const ACCENT = "#007F6E";
const LIGHT = "#BFDFDB";
const MUTED = "#8A8F98";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fmt(x: number): string {
  return (Math.round(x * 100) / 100).toString();
}

function marker(shape: number, x: number, y: number, r: number, fill: string, stroke: string): string {
  const a = `fill="${fill}" stroke="${stroke}" stroke-width="1"`;
  switch (shape % 6) {
    case 0:
      return `<circle cx="${fmt(x)}" cy="${fmt(y)}" r="${r}" ${a}/>`;
    case 1:
      return `<rect x="${fmt(x - r)}" y="${fmt(y - r)}" width="${2 * r}" height="${2 * r}" ${a}/>`;
    case 2:
      return `<polygon points="${fmt(x)},${fmt(y - r * 1.2)} ${fmt(x + r * 1.1)},${fmt(y + r * 0.8)} ${fmt(x - r * 1.1)},${fmt(y + r * 0.8)}" ${a}/>`;
    case 3:
      return `<polygon points="${fmt(x)},${fmt(y - r * 1.3)} ${fmt(x + r * 1.3)},${fmt(y)} ${fmt(x)},${fmt(y + r * 1.3)} ${fmt(x - r * 1.3)},${fmt(y)}" ${a}/>`;
    case 4:
      return `<polygon points="${fmt(x - r)},${fmt(y + r)} ${fmt(x + r)},${fmt(y + r)} ${fmt(x)},${fmt(y - r * 1.2)}" transform="rotate(180 ${fmt(x)} ${fmt(y)})" ${a}/>`;
    default:
      return `<path d="M${fmt(x - r)} ${fmt(y - r)}L${fmt(x + r)} ${fmt(y + r)}M${fmt(x + r)} ${fmt(y - r)}L${fmt(x - r)} ${fmt(y + r)}" stroke="${stroke === "none" ? fill : stroke}" stroke-width="2" fill="none"/>`;
  }
}

export function fpcaSvg(r: ReportJson): string {
  const W = 680;
  const H = 440;
  const L = 56;
  const T = 40;
  const PW = 430;
  const PH = 330;
  const map = r.solution_map;
  const G = new Set(r.goldilocks.G);
  const pts = Object.entries(map.fpca.scores);
  const xs = pts.map(([, s]) => s[0]);
  const ys = pts.map(([, s]) => s[1]);
  const pad = (lo: number, hi: number) => (hi - lo < 1e-9 ? [lo - 0.5, hi + 0.5] : [lo - 0.06 * (hi - lo), hi + 0.06 * (hi - lo)]);
  const [x0, x1] = pad(Math.min(...xs), Math.max(...xs));
  const [y0, y1] = pad(Math.min(...ys), Math.max(...ys));
  const sx = (x: number) => L + ((x - x0) / (x1 - x0)) * PW;
  const sy = (y: number) => T + PH - ((y - y0) / (y1 - y0)) * PH;
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="Arial, Helvetica, sans-serif" role="img" aria-label="FPCA solution map">`);
  out.push(`<rect width="${W}" height="${H}" fill="#FFFFFF"/>`);
  out.push(`<text x="${L}" y="24" font-size="15" font-weight="bold" fill="${ACCENT}">Solution map (FPCA of P(in zone) curves along ${esc(map.multipliers.length + "-point axis")})</text>`);
  out.push(`<rect x="${L}" y="${T}" width="${PW}" height="${PH}" fill="none" stroke="${LIGHT}"/>`);
  for (let i = 0; i <= 4; i++) {
    const gx = L + (i / 4) * PW;
    const gy = T + (i / 4) * PH;
    out.push(`<line x1="${fmt(gx)}" y1="${T}" x2="${fmt(gx)}" y2="${T + PH}" stroke="${LIGHT}" stroke-width="0.5"/>`);
    out.push(`<line x1="${L}" y1="${fmt(gy)}" x2="${L + PW}" y2="${fmt(gy)}" stroke="${LIGHT}" stroke-width="0.5"/>`);
    out.push(`<text x="${fmt(gx)}" y="${T + PH + 16}" font-size="10" text-anchor="middle" fill="${INK}">${fmt(x0 + (i / 4) * (x1 - x0))}</text>`);
    out.push(`<text x="${L - 6}" y="${fmt(T + PH - (i / 4) * PH + 3)}" font-size="10" text-anchor="end" fill="${INK}">${fmt(y0 + (i / 4) * (y1 - y0))}</text>`);
  }
  const ev = map.fpca.explained.map((e) => `${Math.round(e * 100)}%`);
  out.push(`<text x="${L + PW / 2}" y="${T + PH + 34}" font-size="11" text-anchor="middle" fill="${INK}">FPC 1 (${ev[0] ?? "0%"} of variance)</text>`);
  out.push(`<text x="16" y="${T + PH / 2}" font-size="11" text-anchor="middle" fill="${INK}" transform="rotate(-90 16 ${T + PH / 2})">FPC 2 (${ev[1] ?? "0%"} of variance)</text>`);
  // Draw rejected first, Goldilocks members on top.
  const sorted = [...pts].sort((a, b) => Number(G.has(a[0])) - Number(G.has(b[0])) || (a[0] < b[0] ? -1 : 1));
  for (const [id, [x, y]] of sorted) {
    const fam = map.assignment[id];
    const inG = G.has(id);
    out.push(`<g><title>${esc(id)}${inG ? " (Goldilocks)" : ""}</title>${marker(fam, sx(x), sy(y), inG ? 5.5 : 4, inG ? ACCENT : "#FFFFFF", inG ? INK : MUTED)}</g>`);
  }
  let ly = T + 6;
  const lx = L + PW + 22;
  out.push(`<text x="${lx}" y="${ly + 4}" font-size="12" font-weight="bold" fill="${ACCENT}">Families</text>`);
  ly += 22;
  for (const f of map.families) {
    out.push(marker(f.id, lx + 6, ly - 4, 4.5, f.in_goldilocks ? ACCENT : "#FFFFFF", f.in_goldilocks ? INK : MUTED));
    out.push(`<text x="${lx + 18}" y="${ly}" font-size="11" fill="${INK}">F${f.id + 1}: ${f.members.length} candidates</text>`);
    out.push(`<text x="${lx + 18}" y="${ly + 13}" font-size="10" fill="${INK}">${f.in_goldilocks ? "contains a Goldilocks pick" : `binding: ${esc(f.most_binding ?? "-")}`}</text>`);
    ly += 32;
  }
  out.push(`<text x="${lx}" y="${ly + 8}" font-size="10" fill="${INK}">Filled = Goldilocks member</text>`);
  out.push(`</svg>`);
  return out.join("\n") + "\n";
}
