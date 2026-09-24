import { OperatingSystem } from '../../../../base/common/platform.js';
import type {
	IKeyboardLayoutDefinition,
	IKeyboardLayoutInfo,
	IKeyboardMapping,
	IKeyboardMappingEntry,
} from '../../../../platform/keyboardLayout/common/keyboardLayout.js';

interface IWindowsLayoutInfo {
	readonly name: string;
	readonly id: string;
	readonly text: string;
	readonly isUSStandard?: true;
}

interface IMacLayoutInfo {
	readonly id: string;
	readonly lang: string;
	readonly localizedName?: string;
	readonly isUSStandard?: true;
}

interface ILinuxLayoutInfo {
	readonly model: string;
	readonly group: number;
	readonly layout: string;
	readonly variant: string;
	readonly options: string;
	readonly rules: string;
	readonly isUSStandard?: true;
}

export type IRawKeyboardLayoutInfo = IWindowsLayoutInfo | IMacLayoutInfo | ILinuxLayoutInfo;
export type ISerializedKeyboardMapping = Readonly<Record<string, readonly (string | number)[]>>;

/** Serialized layout format used by the built-in VS Code keyboard-layout corpus. */
export interface IKeymapInfo {
	readonly layout: IRawKeyboardLayoutInfo;
	readonly secondaryLayouts: readonly IRawKeyboardLayoutInfo[];
	readonly mapping: ISerializedKeyboardMapping;
}

export function deserializeKeyboardMapping(serialized: ISerializedKeyboardMapping): IKeyboardMapping {
	const mapping: Record<string, IKeyboardMappingEntry> = {};
	for (const [code, values] of Object.entries(serialized)) {
		const mask = Number(values[4] ?? 0);
		mapping[code] = Object.freeze({
			value: String(values[0] ?? ''),
			withShift: String(values[1] ?? ''),
			withAltGr: String(values[2] ?? ''),
			withShiftAltGr: String(values[3] ?? ''),
			valueIsDeadKey: (mask & 1) !== 0,
			withShiftIsDeadKey: (mask & 2) !== 0,
			withAltGrIsDeadKey: (mask & 4) !== 0,
			withShiftAltGrIsDeadKey: (mask & 8) !== 0,
			vkey: typeof values[5] === 'string' ? values[5] : undefined,
		});
	}
	return Object.freeze(mapping);
}

export function toKeyboardLayoutDefinitions(info: IKeymapInfo): readonly IKeyboardLayoutDefinition[] {
	const mapping = deserializeKeyboardMapping(info.mapping);
	return [info.layout, ...info.secondaryLayouts].map((layout) => Object.freeze({
		layout: toKeyboardLayoutInfo(layout),
		mapping,
	}));
}

function toKeyboardLayoutInfo(layout: IRawKeyboardLayoutInfo): IKeyboardLayoutInfo {
	if ('name' in layout) {
		return Object.freeze({
			id: layout.name,
			label: layout.text,
			source: 'builtin',
			operatingSystem: OperatingSystem.Windows,
			isUSStandard: layout.isUSStandard,
		});
	}
	if ('lang' in layout) {
		return Object.freeze({
			id: layout.id,
			label: layout.localizedName ?? layout.id.replace(/^com\.apple\.keylayout\./u, '').replace(/-/gu, ' '),
			source: 'builtin',
			operatingSystem: OperatingSystem.Macintosh,
			isUSStandard: layout.isUSStandard,
		});
	}
	return Object.freeze({
		id: layout.layout,
		label: layout.variant ? `${layout.layout} (${layout.variant})` : layout.layout,
		source: 'builtin',
		operatingSystem: OperatingSystem.Linux,
		isUSStandard: layout.isUSStandard,
	});
}
