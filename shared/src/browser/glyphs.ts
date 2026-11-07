/** Vector art: game-icons.net monster silhouettes and the small stat glyphs. */
import { ICONS, MONSTER_ICON } from './monsterIcons.js';

function svgEl(viewBox: string, body: string, cls: string, title?: string): HTMLElement {
  const span = document.createElement('span');
  span.className = cls;
  span.innerHTML = `<svg viewBox="${viewBox}" aria-hidden="true" focusable="false">${body}</svg>`;
  if (title) span.title = title;
  return span;
}

/** A monster's silhouette, or its emoji when no art is mapped. */
export function monsterArt(defId: string | undefined, emoji: string, cls = ''): HTMLElement {
  const icon = defId ? ICONS[MONSTER_ICON[defId] ?? ''] : undefined;
  if (!icon) {
    const s = document.createElement('span');
    s.className = `mart emoji ${cls}`;
    s.textContent = emoji;
    return s;
  }
  return svgEl('0 0 512 512', `<g fill="currentColor">${icon.body}</g>`, `mart ${cls}`);
}

const HEART = '<path fill="currentColor" d="M12 21.2 10.6 20C5.4 15.4 2 12.3 2 8.5 2 5.4 4.4 3 7.5 3c1.7 0 3.4.8 4.5 2.1C13.1 3.8 14.8 3 16.5 3 19.6 3 22 5.4 22 8.5c0 3.8-3.4 6.9-8.6 11.5L12 21.2z"/>';
const SPARK = '<path fill="currentColor" d="M12 1.5c.5 4.6 1.8 7.4 3.4 9 1.6 1.6 4.4 2.9 7.1 3.5-2.7.6-5.5 1.9-7.1 3.5-1.6 1.6-2.9 3.2-3.4 6-.5-2.8-1.8-4.4-3.4-6C7 15.9 4.2 14.6 1.5 14c2.7-.6 5.5-1.9 7.1-3.5 1.6-1.6 2.9-4.4 3.4-9z"/>';

export const heartIcon = () => svgEl('0 0 24 24', HEART, 'gl gl-heart', 'Hit points');
export const sparkIcon = () => svgEl('0 0 24 24', SPARK, 'gl gl-spark', 'Spell points');
