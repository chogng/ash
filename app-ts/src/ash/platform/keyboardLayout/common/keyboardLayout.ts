import type { Event } from '../../../base/common/event.js';
import type { Keybinding, KeybindingEvent, ResolvedKeybinding } from '../../../base/common/keybindings.js';
import type { OperatingSystem } from '../../../base/common/platform.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';

export enum KeyboardDispatchMode {
	Code = 'code',
	KeyCode = 'keyCode',
}

export interface IKeyboardMapperConfiguration {
	readonly dispatch: KeyboardDispatchMode;
	readonly mapAltGrToCtrlAlt: boolean;
}

/** All printable outputs of one physical key. Empty values mean that the layout does not define that state. */
export interface IKeyboardMappingEntry {
	readonly value: string;
	readonly withShift: string;
	readonly withAltGr: string;
	readonly withShiftAltGr: string;
	readonly valueIsDeadKey?: boolean;
	readonly withShiftIsDeadKey?: boolean;
	readonly withAltGrIsDeadKey?: boolean;
	readonly withShiftAltGrIsDeadKey?: boolean;
	/** Native Windows virtual-key name when supplied by the desktop host. */
	readonly vkey?: string;
}

export type IKeyboardMapping = Readonly<Record<string, IKeyboardMappingEntry>>;

export type KeyboardLayoutSource = 'browser' | 'builtin' | 'fallback' | 'native' | 'user';

/** Identifies one keyboard layout and the source that supplied its mapping. */
export interface IKeyboardLayoutInfo {
	readonly id: string;
	readonly label: string;
	readonly source: KeyboardLayoutSource;
	readonly operatingSystem?: OperatingSystem;
	readonly isUSStandard?: boolean;
}

export interface IKeyboardLayoutDefinition {
	readonly layout: IKeyboardLayoutInfo;
	readonly mapping: IKeyboardMapping;
}

/** Optional host source used by Electron to provide OS-native mappings. */
export interface IKeyboardLayoutProvider {
	readonly onDidChangeKeyboardLayout: Event<void>;
	readKeyboardLayout(): Promise<IKeyboardLayoutDefinition | undefined>;
}

/** Maps native events and configured bindings through one immutable keyboard-layout snapshot. */
export interface IKeyboardMapper {
	dumpDebugInfo(): string;
	resolveKeyboardEvent(event: KeybindingEvent): ResolvedKeybinding;
	resolveKeybinding(keybinding: Keybinding): readonly ResolvedKeybinding[];
}

/** Supplies the active keyboard mapper to the Workbench keybinding service. */
export interface IKeyboardLayoutService {
	readonly onDidChangeKeyboardLayout: Event<void>;

	getRawKeyboardMapping(): IKeyboardMapping | undefined;
	getCurrentKeyboardLayout(): IKeyboardLayoutInfo;
	getAllKeyboardLayouts(): readonly IKeyboardLayoutInfo[];
	getKeyboardMapper(): IKeyboardMapper;
	getKeyboardMapperConfiguration(): IKeyboardMapperConfiguration;
	validateCurrentKeyboardMapping(event: KeybindingEvent): void;
	refreshKeyboardLayout(): Promise<void>;
}

export function keyboardMappingEntriesEqual(
	first: IKeyboardMappingEntry | undefined,
	second: IKeyboardMappingEntry | undefined,
): boolean {
	return first === second || Boolean(first && second &&
		first.value === second.value &&
		first.withShift === second.withShift &&
		first.withAltGr === second.withAltGr &&
		first.withShiftAltGr === second.withShiftAltGr &&
		Boolean(first.valueIsDeadKey) === Boolean(second.valueIsDeadKey) &&
		Boolean(first.withShiftIsDeadKey) === Boolean(second.withShiftIsDeadKey) &&
		Boolean(first.withAltGrIsDeadKey) === Boolean(second.withAltGrIsDeadKey) &&
		Boolean(first.withShiftAltGrIsDeadKey) === Boolean(second.withShiftAltGrIsDeadKey) &&
		first.vkey === second.vkey);
}

export function keyboardMappingsEqual(first: IKeyboardMapping | undefined, second: IKeyboardMapping | undefined): boolean {
	if (first === second) {
		return true;
	}
	if (!first || !second) {
		return false;
	}
	const firstCodes = Object.keys(first);
	const secondCodes = Object.keys(second);
	return firstCodes.length === secondCodes.length &&
		firstCodes.every((code) => keyboardMappingEntriesEqual(first[code], second[code]));
}

export const IKeyboardLayoutService = createServiceIdentifier<IKeyboardLayoutService>('keyboardLayoutService');
