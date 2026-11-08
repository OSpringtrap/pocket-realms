import type { TileView, WorldView } from '../protocol.js';
import { svg } from './dom.js';

export const BIOME_COLORS: Record<string, string> = {
  plains: '#d9cf8c',
  forest: '#8fae6f',
  swamp: '#8a9a6b',
  mountains: '#a89a8a',
  desert: '#e4c88f',
  ruins: '#b7a79a',
  coast: '#c9d8c0',
  water: '#8fb3c4',
};
export const BIOME_COLORS_CB: Record<string, string> = {
  plains: '#f0e442',
  forest: '#009e73',
  swamp: '#56b4e9',
  mountains: '#999999',
  desert: '#e69f00',
  ruins: '#cc79a7',
  coast: '#ffffff',
  water: '#0072b2',
};
export const BIOME_EMOJI: Record<string, string> = { plains: '🌾', forest: '🌲', swamp: '🐸', mountains: '⛰️', desert: '🌵', ruins: '🏛️', coast: '🐚', water: '🌊' };

export interface HexMapOptions {
  size?: number;
  colorblind?: boolean;
  onTap?: (q: number, r: number, tile?: TileView) => void;
  showReach?: boolean;
  pings?: { q: number; r: number; color: string }[];
  partyBanner?: string;
  partyEmoji?: string;
  compact?: boolean;
}

function hexPoints(cx: number, cy: number, s: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 180) * (60 * i - 30);
    pts.push(`${(cx + s * Math.cos(a)).toFixed(1)},${(cy + s * Math.sin(a)).toFixed(1)}`);
  }
  return pts.join(' ');
}

export function hexToPixel(q: number, r: number, s: number): [number, number] {
  return [s * Math.sqrt(3) * (q + r / 2), s * 1.5 * r];
}

/** Render the overworld as an SVG element sized to fit its container. */
export function renderHexMap(w: WorldView, o: HexMapOptions = {}): SVGElement {
  const s = o.size ?? 40;
  const R = w.radius;
  const pad = s * 1.2;
  const width = Math.sqrt(3) * s * (2 * R + 1) + pad * 2;
  const height = s * 1.5 * (2 * R) + s * 2 + pad * 2;
  const root = svg('svg', { viewBox: `${-width / 2} ${-height / 2} ${width} ${height}`, class: 'hexmap', preserveAspectRatio: 'xMidYMid meet' });
  const defs = svg('defs');
  const pat = svg('pattern', { id: 'fog', width: 8, height: 8, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, svg('rect', { width: 8, height: 8, fill: '#e8dcc0' }), svg('line', { x1: 0, y1: 0, x2: 0, y2: 8, stroke: '#cbb994', 'stroke-width': 2 }));
  defs.appendChild(pat);
  const glow = svg('filter', { id: 'glow' }, svg('feGaussianBlur', { stdDeviation: 3, result: 'b' }), svg('feMerge', {}, svg('feMergeNode', { in: 'b' }), svg('feMergeNode', { in: 'SourceGraphic' })));
  defs.appendChild(glow);
  root.appendChild(defs);
  const known = new Map(w.tiles.map((t) => [`${t.q},${t.r}`, t]));
  const fogReach = new Set((w.fogReach ?? []).map((f) => `${f.q},${f.r}`));
  const colors = o.colorblind ? BIOME_COLORS_CB : BIOME_COLORS;
  const layer = svg('g');
  root.appendChild(layer);
  // place names go in their own layer above every hex: inside a hex's group the next hex painted
  // over them and cut them off
  const labels: { x: number; y: number; name: string; dim: boolean }[] = [];
  for (let q = -R; q <= R; q++)
    for (let r = Math.max(-R, -q - R); r <= Math.min(R, -q + R); r++) {
      const [x, y] = hexToPixel(q, r, s);
      const t = known.get(`${q},${r}`);
      const g = svg('g', { class: `hex${t ? ' known' : ' fog'}${t?.reachable !== undefined && o.showReach ? ' reach' : ''}`, 'data-q': q, 'data-r': r });
      g.appendChild(svg('polygon', { points: hexPoints(x, y, s * 0.97), fill: t ? colors[t.biome] ?? '#ccc' : 'url(#fog)', stroke: t ? '#6b5434' : '#d6c6a2', 'stroke-width': t ? 1.5 : 1 }));
      if (t) {
        if (!t.poi && !o.compact) g.appendChild(svg('text', { x, y: y + s * 0.15, 'font-size': s * 0.5, 'text-anchor': 'middle', opacity: 0.45 }, BIOME_EMOJI[t.biome] ?? ''));
        if (t.poi) {
          g.appendChild(svg('text', { x, y: y + s * 0.2, 'font-size': s * 0.8, 'text-anchor': 'middle', opacity: t.poi.cleared ? 0.45 : 1 }, t.poi.emoji));
          if (!o.compact) labels.push({ x, y, name: t.poi.name, dim: !!t.poi.cleared });
          if (t.poi.cleared) g.appendChild(svg('text', { x: x + s * 0.45, y: y - s * 0.35, 'font-size': s * 0.35, 'text-anchor': 'middle' }, '✔️'));
        }
        if (t.reachable !== undefined && o.showReach) {
          g.appendChild(svg('polygon', { points: hexPoints(x, y, s * 0.82), fill: 'none', stroke: '#f5c542', 'stroke-width': 3, class: 'reach-ring', filter: 'url(#glow)' }));
        }
      }
      if (!t && o.showReach && fogReach.has(`${q},${r}`)) {
        g.appendChild(svg('polygon', { points: hexPoints(x, y, s * 0.82), fill: 'none', stroke: '#f5c542', 'stroke-width': 3, class: 'reach-ring', filter: 'url(#glow)' }));
        g.appendChild(svg('text', { x, y: y + s * 0.18, 'font-size': s * 0.5, 'text-anchor': 'middle', opacity: 0.6 }, '❔'));
      }
      if (o.onTap) {
        g.addEventListener('click', () => o.onTap!(q, r, t));
        g.style.cursor = t?.reachable !== undefined || fogReach.has(`${q},${r}`) ? 'pointer' : 'default';
      }
      layer.appendChild(g);
    }
  // fortress glows ominously even when far away
  if (w.objective.fortress) {
    const [fx, fy] = hexToPixel(w.objective.fortress.q, w.objective.fortress.r, s);
    root.appendChild(svg('circle', { cx: fx, cy: fy, r: s * 0.95, fill: 'none', stroke: '#8b1e1e', 'stroke-width': 2.5, 'stroke-dasharray': '6 4', class: 'fortress-ring' }));
  }
  for (const p of o.pings ?? []) {
    const [px, py] = hexToPixel(p.q, p.r, s);
    root.appendChild(svg('circle', { cx: px, cy: py, r: s * 0.6, fill: 'none', stroke: p.color, 'stroke-width': 4, class: 'ping' }));
  }
  const labelLayer = svg('g', { class: 'hexlabels' });
  const fs = s * 0.28;
  for (const l of labels) {
    const lines = wrapLabel(l.name, 11);
    const lh = fs * 1.08;
    const top = l.y + s * 0.5;
    const wMax = Math.max(...lines.map((t) => t.length)) * fs * 0.54 + fs * 0.6;
    const g = svg('g', { class: `hexlabel-g${l.dim ? ' dim' : ''}` });
    g.appendChild(svg('rect', { x: l.x - wMax / 2, y: top - fs * 0.15, width: wMax, height: lines.length * lh + fs * 0.3, rx: fs * 0.35, class: 'hexlabel-bg' }));
    lines.forEach((t, i) => g.appendChild(svg('text', { x: l.x, y: top + lh * (i + 0.8), 'font-size': fs, 'text-anchor': 'middle', class: 'hexlabel' }, t)));
    labelLayer.appendChild(g);
  }
  root.appendChild(labelLayer);
  root.appendChild(partyToken(w.party, s, o.partyEmoji));
  return root;
}

/** A name in at most three lines of about `max` characters, broken between words. */
export function wrapLabel(name: string, max: number, maxLines = 3): string[] {
  const words = name.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const wd of words) {
    if (!cur) cur = wd;
    else if (cur.length + 1 + wd.length <= max) cur += ` ${wd}`;
    else {
      lines.push(cur);
      cur = wd;
    }
  }
  if (cur) lines.push(cur);
  const clip = (l: string) => (l.length > max + 3 ? `${l.slice(0, max + 2).trimEnd()}…` : l);
  if (lines.length <= maxLines) return lines.map(clip);
  return [...lines.slice(0, maxLines - 1), clip(lines.slice(maxLines - 1).join(' '))];
}

/** The party: a banner on a pole planted in its hex, waving, with a beacon ring under it. */
function partyToken(at: { q: number; r: number }, s: number, emoji?: string): SVGElement {
  const [x, y] = hexToPixel(at.q, at.r, s);
  const token = svg('g', { class: 'party-token', transform: `translate(${x},${y})` });
  token.appendChild(svg('circle', { r: s * 0.7, class: 'party-beacon' }));
  token.appendChild(svg('ellipse', { cx: -s * 0.42, cy: s * 0.42, rx: s * 0.2, ry: s * 0.07, fill: 'rgba(40, 25, 10, 0.35)' }));
  // the pole stands left of centre so it does not cross the place's emoji and name
  const bob = svg('g', { class: 'party-bob' });
  const poleTop = -s * 1.55;
  const base = s * 0.4;
  bob.appendChild(svg('line', { x1: 0, y1: base, x2: 0, y2: poleTop, stroke: '#3b2412', 'stroke-width': s * 0.09, 'stroke-linecap': 'round' }));
  bob.appendChild(svg('circle', { cx: 0, cy: poleTop, r: s * 0.09, fill: '#e8c15a', stroke: '#6b4a12', 'stroke-width': 1 }));
  // swallow-tailed pennant; its edge ripples (SMIL keeps it inside the SVG, no layout work)
  const fw = s * 1.45;
  const fh = s * 0.9;
  const y0 = poleTop + s * 0.06;
  const flag = (k: number) =>
    `M0,${y0} C${fw * 0.35},${y0 - fh * 0.12 * k} ${fw * 0.65},${y0 + fh * 0.12 * k} ${fw},${y0} L${fw * 0.8},${y0 + fh / 2} L${fw},${y0 + fh} C${fw * 0.65},${y0 + fh + fh * 0.12 * k} ${fw * 0.35},${y0 + fh - fh * 0.12 * k} 0,${y0 + fh} Z`;
  const path = svg('path', { d: flag(1), fill: '#a3241c', stroke: '#f3e2b0', 'stroke-width': s * 0.06, 'stroke-linejoin': 'round' });
  path.appendChild(svg('animate', { attributeName: 'd', dur: '1.6s', repeatCount: 'indefinite', values: `${flag(1)};${flag(-1)};${flag(1)}` }));
  bob.appendChild(path);
  bob.appendChild(svg('text', { x: fw * 0.38, y: y0 + fh * 0.5 + s * 0.17, 'font-size': s * 0.5, 'text-anchor': 'middle' }, emoji ?? '⚔️'));
  token.appendChild(svg('g', { transform: `translate(${-s * 0.42},0)` }, bob));
  return token;
}
