import type { ResolvedKeybinding, ResolvedKeybindingChord } from '../../../base/common/keybindings.js';

/** Returns an Electron accelerator only for a single supported key combination. */
export function toElectronAccelerator(keybinding: ResolvedKeybinding | undefined): string | undefined {
	if (!keybinding || keybinding.chords.length !== 1) return undefined;
	const chord = keybinding.chords[0];
	const key = electronKey(chord);
	if (!key) return undefined;

	const parts: string[] = [];
	if (chord.metaKey) parts.push('Command');
	if (chord.ctrlKey) parts.push('Control');
	if (chord.altKey) parts.push('Alt');
	if (chord.shiftKey) parts.push('Shift');
	parts.push(key);
	return parts.join('+');
}

function electronKey(chord: ResolvedKeybindingChord): string | undefined {
	const key = chord.label ?? chord.key;
	if (/^[a-z0-9]$/i.test(key)) return key.toUpperCase();
	if (/^Key[A-Z]$/.test(key)) return key.slice(3);
	if (/^Digit[0-9]$/.test(key)) return key.slice(5);
	if (/^F(?:[1-9]|1[0-9]|2[0-4])$/i.test(key)) return key.toUpperCase();
	const knownKeys: Readonly<Record<string, string>> = {
		' ': 'Space',
		arrowdown: 'Down',
		arrowleft: 'Left',
		arrowright: 'Right',
		arrowup: 'Up',
		backspace: 'Backspace',
		delete: 'Delete',
		end: 'End',
		enter: 'Enter',
		escape: 'Escape',
		home: 'Home',
		pagedown: 'PageDown',
		pageup: 'PageUp',
		space: 'Space',
		tab: 'Tab',
	};
	return knownKeys[key.toLocaleLowerCase('en-US')];
}
