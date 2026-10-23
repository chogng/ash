import { lxiconsLibrary } from './lxiconsLibrary.js';
import { getLxiconDefinition, registerLxicon } from './lxiconsUtil.js';
import type { Icon } from './icon.js';

function registerDerivedIcon(id: string, source: Icon): Icon {
	const definition = getLxiconDefinition(source.id);
	if (!definition) {
		throw new ReferenceError(`Unknown icon '${source.id}'`);
	}
	return registerLxicon(id, definition);
}

// Derived IDs share glyphs but retain independent product theme overrides.
const lxiconsDerived = {
	dialogError: registerDerivedIcon('dialog-error', lxiconsLibrary.error),
	dialogWarning: registerDerivedIcon('dialog-warning', lxiconsLibrary.warning),
	dialogInfo: registerDerivedIcon('dialog-info', lxiconsLibrary.info),
	dialogClose: registerDerivedIcon('dialog-close', lxiconsLibrary.close),
	treeItemExpanded: registerDerivedIcon('tree-item-expanded', lxiconsLibrary.chevronDown),
	menuSelection: registerDerivedIcon('menu-selection', lxiconsLibrary.check),
	menuBarMore: registerDerivedIcon('menubar-more', lxiconsLibrary.ellipsis),
	toolBarMore: registerDerivedIcon('toolbar-more', lxiconsLibrary.ellipsis),
	quickInputBack: registerDerivedIcon('quick-input-back', lxiconsLibrary.arrowLeft),
	dropDownButton: registerDerivedIcon('drop-down-button', lxiconsLibrary.chevronDown),
} as const;

/** Built-in icon identities backed by prepared native font glyphs. */
export const Lxicon = Object.freeze({ ...lxiconsLibrary, ...lxiconsDerived });

export function getAllLxicons(): readonly Icon[] {
	return Object.values(Lxicon);
}
