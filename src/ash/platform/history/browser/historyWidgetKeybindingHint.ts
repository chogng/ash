import type { ResolvedKeybinding } from '../../../base/common/keybindings.js';
import type { Context } from '../../contextkey/common/contextkey.js';
import type { IKeybindingService } from '../../keybinding/common/keybinding.js';

export function showHistoryKeybindingHint(keybindingService: IKeybindingService, context?: Context): boolean {
	return hasPlainArrow(keybindingService.lookupKeybindings('history.showPrevious', context), 'arrowup')
		&& hasPlainArrow(keybindingService.lookupKeybindings('history.showNext', context), 'arrowdown');
}

function hasPlainArrow(keybindings: readonly ResolvedKeybinding[], key: string): boolean {
	return keybindings.some(keybinding => {
		if (keybinding.chords.length !== 1) return false;
		const chord = keybinding.chords[0];
		return chord.key.toLowerCase() === key && !chord.ctrlKey && !chord.shiftKey && !chord.altKey && !chord.metaKey;
	});
}
