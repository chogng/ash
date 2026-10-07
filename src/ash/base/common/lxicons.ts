import { lxiconsLibrary } from './lxiconsLibrary.js';
import type { Icon } from './icon.js';

/** Built-in SVG artwork. Product components register semantic icons with these as defaults. */
export const Lxicon = Object.freeze({ ...lxiconsLibrary });

export function getAllLxicons(): readonly Icon[] {
	return Object.values(Lxicon);
}
