import { Event } from '../../../../base/common/event.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import type { IKeybindingService } from '../../common/keybinding.js';

/** Presentation tests have no shortcut rules; unexpected resolution must fail the test. */
export function createLabelKeybindingService(): IKeybindingService {
	return {
		inChordMode: false,
		onDidUpdateKeybindings: Event.None,
		getKeybindings: () => [],
		enableKeybindingHoldMode: () => undefined,
		registerSchemaContribution: () => toDisposable(() => { }),
		resolveKeybinding: () => { throw new Error('Unexpected keybinding resolution in a presentation fixture'); },
		resolveUserBinding: () => undefined,
		lookupKeybindings: () => [],
		lookupKeybinding: () => undefined,
	};
}
