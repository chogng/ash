import type { Icon, IconDefinition } from './icon.js';

const definitions = new Map<string, IconDefinition>();

/** Registers a prepared font glyph by definition or Unicode codepoint. */
export function registerLxicon(id: string, definition: IconDefinition | number): Icon {
	if (definitions.has(id)) throw new TypeError(`Lxicon '${id}' is already registered`);
	definitions.set(id, typeof definition === 'number' ? { fontCharacter: String.fromCodePoint(definition) } : definition);
	return { id };
}

export function getLxiconDefinition(id: string): IconDefinition | undefined {
	return definitions.get(id);
}
