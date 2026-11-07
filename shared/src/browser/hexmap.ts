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
  const colors = o.colorblind ? BIOME_COLORS_CB : BIOME_COLORS;
  const layer = svg('g');
  root.appendChild(layer);
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
          if (!o.compact) g.appendChild(svg('text', { x, y: y + s * 0.85, 'font-size': s * 0.26, 'text-anchor': 'middle', class: 'hexlabel' }, t.poi.name.length > 18 ? `${t.poi.name.slice(0, 17)}…` : t.poi.name));
          if (t.poi.cleared) g.appendChild(svg('text', { x: x + s * 0.45, y: y - s * 0.35, 'font-size': s * 0.35, 'text-anchor': 'middle' }, '✔️'));
        }
        if (t.reachable !== undefined && o.showReach) {
          g.appendChild(svg('polygon', { points: hexPoints(x, y, s * 0.82), fill: 'none', stroke: '#f5c542', 'stroke-width': 3, class: 'reach-ring', filter: 'url(#glow)' }));
        }
      }
      if (o.onTap) {
        g.addEventListener('click', () => o.onTap!(q, r, t));
        g.style.cursor = t?.reachable !== undefined ? 'pointer' : 'default';
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
  const [x, y] = hexToPixel(w.party.q, w.party.r, s);
  const token = svg('g', { class: 'party-token', transform: `translate(${x},${y})` });
  token.appendChild(svg('circle', { r: s * 0.42, fill: '#7a1f1f', stroke: '#f3e6c4', 'stroke-width': 3 }));
  token.appendChild(svg('text', { y: s * 0.17, 'font-size': s * 0.45, 'text-anchor': 'middle' }, o.partyEmoji ?? '🚩'));
  root.appendChild(token);
  return root;
}
