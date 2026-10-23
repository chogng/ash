import type { Icon, IconDefinition } from './icon.js';

const definitions = new Map<string, IconDefinition>();

/** Registers glyphs and dedicated artwork from Ash's generated icon catalog. */
export function registerLxicon(id: string, definition: IconDefinition): Icon {
	if (definitions.has(id)) throw new TypeError(`Lxicon '${id}' is already registered`);
	definitions.set(id, definition);
	return { id };
}

export function getLxiconDefinition(id: string): IconDefinition | undefined {
	return definitions.get(id);
}
