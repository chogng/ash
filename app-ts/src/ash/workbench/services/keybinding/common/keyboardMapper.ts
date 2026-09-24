import {
	IMMUTABLE_CODE_TO_KEY_CODE,
	IMMUTABLE_KEY_CODE_TO_CODE,
	KeyCode,
	KeyCodeUtils,
	NATIVE_WINDOWS_KEY_CODE_TO_KEY_CODE,
	ScanCode,
	ScanCodeUtils,
} from '../../../../base/common/keyCodes.js';
import {
	Keybinding,
	KeybindingChordKind,
	logicalKey,
	normalizeLogicalKey,
	physicalKey,
	ResolvedKeybinding,
	resolveKeybinding,
	type KeybindingEvent,
	type ResolvedKeybindingChord,
} from '../../../../base/common/keybindings.js';
import { OperatingSystem } from '../../../../base/common/platform.js';
import {
	KeyboardDispatchMode,
	type IKeyboardMapper,
	type IKeyboardMapperConfiguration,
	type IKeyboardMapping,
} from '../../../../platform/keyboardLayout/common/keyboardLayout.js';
import { findKeyboardMappingCandidates, getKeyboardMappingLabel, isKeyboardMappingDeadKey } from './keyboardMapping.js';

export abstract class KeyboardMapper implements IKeyboardMapper {
	constructor(
		protected readonly mapping: IKeyboardMapping,
		protected readonly configuration: IKeyboardMapperConfiguration,
		protected readonly operatingSystem: OperatingSystem,
	) {}

	public abstract dumpDebugInfo(): string;

	protected dumpMappingTable(mapperName: string, summary?: string): string {
		const rows = [
			`Mapper: ${mapperName}`,
			`Operating system: ${this.operatingSystem}`,
			`Dispatch mode: ${this.configuration.dispatch}`,
			`Map AltGr to Ctrl+Alt: ${this.configuration.mapAltGrToCtrlAlt}`,
			...(summary ? [summary] : []),
			'',
			'Code | Base | Shift | AltGr | Shift+AltGr | Dead states | VKey | Physical dispatch',
			'--- | --- | --- | --- | --- | --- | --- | ---',
		];
		const entries = Object.entries(this.mapping).sort(([first], [second]) => {
			const firstScanCode = ScanCodeUtils.toEnum(first);
			const secondScanCode = ScanCodeUtils.toEnum(second);
			return firstScanCode === secondScanCode
				? first.localeCompare(second)
				: firstScanCode - secondScanCode;
		});
		for (const [code, entry] of entries) {
			const deadStates = [
				entry.valueIsDeadKey ? 'base' : '',
				entry.withShiftIsDeadKey ? 'shift' : '',
				entry.withAltGrIsDeadKey ? 'altgr' : '',
				entry.withShiftAltGrIsDeadKey ? 'shift+altgr' : '',
			].filter(Boolean).join(', ');
			rows.push([
				code,
				debugValue(entry.value),
				debugValue(entry.withShift),
				debugValue(entry.withAltGr),
				debugValue(entry.withShiftAltGr),
				deadStates || '-',
				entry.vkey || '-',
				`[${code}] / shift+[${code}] / ctrl+alt+[${code}] / ctrl+shift+alt+[${code}]`,
			].join(' | '));
		}
		return rows.join('\n');
	}

	public resolveKeyboardEvent(event: KeybindingEvent): ResolvedKeybinding {
		const ctrlKey = event.ctrlKey || (this.configuration.mapAltGrToCtrlAlt && Boolean(event.altGraphKey));
		const altKey = event.altKey || (this.configuration.mapAltGrToCtrlAlt && Boolean(event.altGraphKey));
		const modifiers = {
			ctrlKey,
			shiftKey: event.shiftKey,
			altKey,
			metaKey: event.metaKey,
		};
		const logicalKeyValue = event.keyCode !== undefined && event.keyCode > KeyCode.Unknown
			? KeyCodeUtils.toString(event.keyCode)
			: event.key;
		const chord = isModifierKeyCode(event.keyCode)
			? logicalKey(KeyCodeUtils.toString(event.keyCode!), {})
			: this.configuration.dispatch === KeyboardDispatchMode.Code || event.key === 'Dead'
			? physicalKey(event.code, modifiers)
			: logicalKey(logicalKeyValue, modifiers);
		return this.resolveKeybinding(Keybinding.single(chord))[0] ??
			resolveKeybinding(Keybinding.single(chord), this.operatingSystem);
	}

	public resolveKeybinding(keybinding: Keybinding): readonly ResolvedKeybinding[] {
		const resolved = resolveKeybinding(
			keybinding,
			this.operatingSystem,
			(code, modifiers) => getKeyboardMappingLabel(
				code,
				this.mapping[code],
				modifiers,
				this.configuration.mapAltGrToCtrlAlt,
			),
		);
		const enriched = new ResolvedKeybinding(
			resolved.chords.map((chord) => this.enrichChord(chord)),
			this.operatingSystem,
		);
		if (this.configuration.dispatch === KeyboardDispatchMode.KeyCode) {
			return [enriched];
		}
		return this.resolveCodeDispatch(enriched);
	}

	private enrichChord(chord: ResolvedKeybindingChord): ResolvedKeybindingChord {
		if (chord.kind === KeybindingChordKind.Physical) {
			const scanCode = ScanCodeUtils.toEnum(chord.key);
			const immutableKeyCode = IMMUTABLE_CODE_TO_KEY_CODE[scanCode];
			const windowsKeyCode = this.operatingSystem === OperatingSystem.Windows
				? NATIVE_WINDOWS_KEY_CODE_TO_KEY_CODE[this.mapping[chord.key]?.vkey ?? '']
				: undefined;
			return {
				...chord,
				keyCode: windowsKeyCode ?? (
					immutableKeyCode !== KeyCode.DependsOnKeyboardLayout
						? immutableKeyCode
						: undefined
				),
				scanCode,
				isDeadKey: isKeyboardMappingDeadKey(
					this.mapping[chord.key],
					chord,
					this.configuration.mapAltGrToCtrlAlt,
				),
			};
		}
		return { ...chord, keyCode: KeyCodeUtils.fromString(chord.key) };
	}

	private resolveCodeDispatch(keybinding: ResolvedKeybinding): readonly ResolvedKeybinding[] {
		let candidates: readonly (readonly ResolvedKeybindingChord[])[] = [[]];
		for (const chord of keybinding.chords) {
			const chordCandidates = this.resolveChordToCodes(chord);
			const next: ResolvedKeybindingChord[][] = [];
			for (const prefix of candidates) {
				for (const candidate of chordCandidates) {
					next.push([...prefix, candidate]);
				}
			}
			candidates = next;
		}
		return candidates.map((chords) => new ResolvedKeybinding(chords, this.operatingSystem));
	}

	private resolveChordToCodes(chord: ResolvedKeybindingChord): readonly ResolvedKeybindingChord[] {
		if (chord.kind === KeybindingChordKind.Physical) {
			return [chord];
		}
		const keyCode = chord.keyCode ?? KeyCodeUtils.fromString(chord.key);
		if (isModifierKeyCode(keyCode)) {
			return [chord];
		}
		const immutableScanCode = IMMUTABLE_KEY_CODE_TO_CODE[keyCode];
		if (immutableScanCode !== undefined && immutableScanCode !== ScanCode.DependsOnKeyboardLayout) {
			return [{
				...chord,
				kind: KeybindingChordKind.Physical,
				key: ScanCodeUtils.toString(immutableScanCode),
				label: getKeyboardMappingLabel(
					ScanCodeUtils.toString(immutableScanCode),
					this.mapping[ScanCodeUtils.toString(immutableScanCode)],
					chord,
					this.configuration.mapAltGrToCtrlAlt,
				),
				scanCode: immutableScanCode,
			}];
		}
		const candidates = findKeyboardMappingCandidates(
			this.mapping,
			normalizeLogicalKey(chord.key),
			keyCode,
			chord,
			this.operatingSystem,
		);
		if (candidates.length === 0) {
			return [chord];
		}
		return candidates.map((candidate) => ({
			...chord,
			kind: KeybindingChordKind.Physical,
			key: candidate.code,
			label: candidate.label,
			scanCode: ScanCodeUtils.toEnum(candidate.code),
			isDeadKey: candidate.isDeadKey,
			ctrlKey: candidate.ctrlKey,
			shiftKey: candidate.shiftKey,
			altKey: candidate.altKey,
			metaKey: candidate.metaKey,
		}));
	}
}

function isModifierKeyCode(keyCode: KeyCode | undefined): boolean {
	return keyCode === KeyCode.Ctrl || keyCode === KeyCode.Shift || keyCode === KeyCode.Alt || keyCode === KeyCode.Meta;
}

function debugValue(value: string): string {
	return value ? JSON.stringify(value) : '""';
}

/** Keeps immutable mapper snapshots cheap to reuse across registry lookups. */
export class CachedKeyboardMapper implements IKeyboardMapper {
	private readonly cache = new WeakMap<Keybinding, readonly ResolvedKeybinding[]>();

	constructor(private readonly actual: IKeyboardMapper) {}

	public dumpDebugInfo(): string {
		return this.actual.dumpDebugInfo();
	}

	public resolveKeyboardEvent(event: KeybindingEvent): ResolvedKeybinding {
		return this.actual.resolveKeyboardEvent(event);
	}

	public resolveKeybinding(keybinding: Keybinding): readonly ResolvedKeybinding[] {
		const cached = this.cache.get(keybinding);
		if (cached) {
			return cached;
		}
		const resolved = this.actual.resolveKeybinding(keybinding);
		this.cache.set(keybinding, resolved);
		return resolved;
	}
}
