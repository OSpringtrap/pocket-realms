/**
 * A hero's dice: material, colour set, typeface and the sound of a natural 20. Chosen on the phone
 * at hero creation (bots get a random set) and drawn wherever that hero's dice appear. Flavour only:
 * nothing here touches rules or the seeded game RNG.
 */

export const DICE_MATERIALS = ['solid', 'resin', 'metal', 'glass', 'glitter', 'galaxy'] as const;
export type DiceMaterial = (typeof DICE_MATERIALS)[number];
export const DICE_MATERIAL_NAMES: Record<DiceMaterial, string> = { solid: 'Solid', resin: 'Resin', metal: 'Metal', glass: 'Glass', glitter: 'Glitter', galaxy: 'Galaxy' };

/** `css`: the family name the bundled font registers; `bold`: it has a real bold weight. */
export const DICE_FONTS = [
  { id: 'cinzel', name: 'Cinzel', css: 'Cinzel', kind: 'Serif capitals', bold: true, scale: 1 },
  { id: 'youngserif', name: 'Young Serif', css: 'Young Serif', kind: 'Serif', bold: false, scale: 1 },
  { id: 'ptsans', name: 'PT Sans', css: 'PT Sans', kind: 'Sans-serif', bold: true, scale: 1.05 },
  { id: 'rubik', name: 'Rubik', css: 'Rubik', kind: 'Sans-serif', bold: true, scale: 1 },
  { id: 'googlesans', name: 'Google Sans Flex', css: 'Google Sans Flex Variable', kind: 'Sans-serif', bold: true, scale: 1 },
  { id: 'alata', name: 'Alata', css: 'Alata', kind: 'Rounded', bold: false, scale: 1.02 },
  { id: 'tiny5', name: 'Tiny5', css: 'Tiny5', kind: 'Pixel', bold: false, scale: 1.1 },
  { id: 'fraktur', name: 'UnifrakturMaguntia', css: 'UnifrakturMaguntia', kind: 'Blackletter', bold: false, scale: 1.08 },
] as const;
export type DiceFontId = (typeof DICE_FONTS)[number]['id'];

/** Colour sets: main colour, second colour (gradient end, shine, flecks, nebula), edges. */
export const DICE_PALETTES = [
  { id: 'parchment', name: 'Parchment', body: '#f4ead2', accent: '#c9a050', edge: '#2a2119' },
  { id: 'ember', name: 'Ember', body: '#a2482c', accent: '#f0a03c', edge: '#3a1408' },
  { id: 'deepsea', name: 'Deep sea', body: '#1d4e6b', accent: '#5fc2c0', edge: '#0b1d29' },
  { id: 'moss', name: 'Moss', body: '#4f7a3a', accent: '#c7d98b', edge: '#1d2b14' },
  { id: 'amethyst', name: 'Amethyst', body: '#6d4a86', accent: '#e0a8f0', edge: '#251433' },
  { id: 'obsidian', name: 'Obsidian', body: '#1c1a1f', accent: '#c9a050', edge: '#000000' },
  { id: 'frost', name: 'Frost', body: '#dfeef5', accent: '#7fb7d6', edge: '#24435a' },
  { id: 'bloodmoon', name: 'Blood moon', body: '#5a0f14', accent: '#e2463f', edge: '#1a0305' },
  { id: 'honey', name: 'Honey', body: '#e7a83a', accent: '#fff0a8', edge: '#4a2a05' },
  { id: 'toxic', name: 'Toxic', body: '#20231c', accent: '#9cf03c', edge: '#0a0c08' },
  { id: 'rosegold', name: 'Rose gold', body: '#e8b4a0', accent: '#fff3e8', edge: '#6b3a30' },
  { id: 'steel', name: 'Steel', body: '#8b9aa3', accent: '#e8eef2', edge: '#14191c' },
  { id: 'nebula', name: 'Nebula', body: '#151036', accent: '#b04cff', edge: '#06041a' },
  { id: 'aurora', name: 'Aurora', body: '#0d2a2a', accent: '#3cf0b0', edge: '#031212' },
  { id: 'sunset', name: 'Sunset', body: '#e8603a', accent: '#ffd27a', edge: '#3a1206' },
  { id: 'royal', name: 'Royal', body: '#1b2a6b', accent: '#c9a050', edge: '#0a1030' },
  { id: 'bubblegum', name: 'Bubblegum', body: '#f59ac0', accent: '#9fe3ff', edge: '#5a1c40' },
  { id: 'copper', name: 'Copper', body: '#b8693a', accent: '#ffcf9e', edge: '#2a1206' },
] as const;
export type DicePaletteId = (typeof DICE_PALETTES)[number]['id'];

export const NAT20_SOUNDS = [
  { id: 'fanfare', name: 'Royal fanfare' },
  { id: 'choir', name: 'Heavenly choir' },
  { id: 'chimes', name: 'Crystal chimes' },
  { id: 'chiptune', name: '8-bit jingle' },
  { id: 'thunder', name: 'Thunder & sparks' },
  { id: 'crowd', name: 'Tavern cheer' },
  { id: 'harp', name: 'Harp glissando' },
  { id: 'powerup', name: 'Power surge' },
  { id: 'none', name: 'Silence' },
] as const;
export type Nat20Sound = (typeof NAT20_SOUNDS)[number]['id'];

export interface DiceStyle {
  material: DiceMaterial;
  palette: DicePaletteId;
  font: DiceFontId;
  bold: boolean;
  /** sun: light, glowing numbers; moon: dark numbers */
  light: boolean;
  /** number size, 1 = default (0.8 to 1.3) */
  size: number;
  nat20: Nat20Sound;
}

/** What dice look like for heroes from before styles existed: the game's old ivory dice. */
export const DEFAULT_DICE: DiceStyle = { material: 'solid', palette: 'parchment', font: 'youngserif', bold: false, light: false, size: 1, nat20: 'fanfare' };

const has = <T extends { id: string }>(list: readonly T[], id: unknown): id is T['id'] => list.some((x) => x.id === id);

/** Clean a style sent by a phone; anything unknown falls back to the default. */
export function sanitizeDiceStyle(raw: unknown): DiceStyle {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const font = has(DICE_FONTS, r.font) ? r.font : DEFAULT_DICE.font;
  const size = Number(r.size);
  return {
    material: (DICE_MATERIALS as readonly unknown[]).includes(r.material) ? (r.material as DiceMaterial) : DEFAULT_DICE.material,
    palette: has(DICE_PALETTES, r.palette) ? r.palette : DEFAULT_DICE.palette,
    font,
    bold: r.bold === true && !!DICE_FONTS.find((f) => f.id === font)?.bold,
    light: r.light === true,
    size: Number.isFinite(size) ? Math.round(Math.min(1.3, Math.max(0.8, size)) * 100) / 100 : 1,
    nat20: has(NAT20_SOUNDS, r.nat20) ? r.nat20 : DEFAULT_DICE.nat20,
  };
}

/** A random set, as a bot picks one (and the phone's shuffle button). Uses its own random source. */
export function randomDiceStyle(rand: () => number = Math.random): DiceStyle {
  const pick = <T>(a: readonly T[]) => a[Math.floor(rand() * a.length)]!;
  const font = pick(DICE_FONTS);
  const palette = pick(DICE_PALETTES);
  return {
    material: pick(DICE_MATERIALS),
    palette: palette.id,
    font: font.id,
    bold: font.bold && rand() < 0.4,
    // light numbers on dark dice, mostly
    light: lum(palette.body) < 0.45 ? rand() < 0.85 : rand() < 0.15,
    size: Math.round((0.9 + rand() * 0.25) * 100) / 100,
    nat20: pick(NAT20_SOUNDS.filter((s) => s.id !== 'none')).id,
  };
}

// ------------------------------------------------------------------ colours

export function hexRgb(h: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(h);
  return m ? [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)] : [200, 200, 200];
}
export function mixHex(a: string, b: string, t: number): string {
  const x = hexRgb(a);
  const y = hexRgb(b);
  return '#' + x.map((v, i) => Math.round(v + (y[i]! - v) * t).toString(16).padStart(2, '0')).join('');
}
export function lum(h: string): number {
  const [r, g, b] = hexRgb(h);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** The colours a style draws with. Numbers are the main colour pushed light (with a glow) or dark. */
export function diceColours(s: DiceStyle) {
  const p = DICE_PALETTES.find((x) => x.id === s.palette) ?? DICE_PALETTES[0];
  return { body: p.body, accent: p.accent, edge: p.edge, ink: s.light ? mixHex(p.body, '#ffffff', 0.9) : mixHex(p.body, '#000000', 0.86), glow: s.light };
}

export function diceFont(s: DiceStyle) {
  return DICE_FONTS.find((f) => f.id === s.font) ?? DICE_FONTS[1];
}
