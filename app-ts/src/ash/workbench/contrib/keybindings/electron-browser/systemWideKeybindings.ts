import { parseKeybinding } from '../../../../base/common/keybindingParser.js';
import { resolveKeybinding } from '../../../../base/common/keybindings.js';
import { OperatingSystem } from '../../../../base/common/platform.js';
import { toElectronAccelerator } from '../../../../platform/keybinding/common/electronAccelerator.js';
import type { IKeybindingEntry } from '../../../../platform/keybinding/common/keybindingsResource.js';
import type { INativeSystemWideKeybinding } from '../../../../platform/native/common/nativeHost.js';

export interface ISystemWideKeybindingSelection {
	readonly candidates: readonly INativeSystemWideKeybinding[];
	readonly unsupported: readonly string[];
	readonly duplicates: readonly string[];
	readonly ignoredWhen: readonly string[];
}

/** Selects explicit user shortcuts that Electron can register with the operating system. */
export function selectSystemWideKeybindings(bindings: readonly IKeybindingEntry[], operatingSystem: OperatingSystem): ISystemWideKeybindingSelection {
	const candidates: INativeSystemWideKeybinding[] = [];
	const unsupported: string[] = [];
	const duplicates: string[] = [];
	const ignoredWhen: string[] = [];
	const seen = new Set<string>();

	for (const binding of bindings) {
		if (binding.systemWide !== true || !binding.command) continue;
		const key = operatingSystem === OperatingSystem.Macintosh ? binding.mac : operatingSystem === OperatingSystem.Windows ? binding.win : binding.linux;
		const label = key === undefined ? binding.key : key;
		if (label === null) continue;
		const parsed = parseKeybinding(label);
		const accelerator = parsed ? toElectronAccelerator(resolveKeybinding(parsed, operatingSystem)) : undefined;
		if (!accelerator) {
			unsupported.push(label);
			continue;
		}
		if (seen.has(accelerator)) {
			duplicates.push(label);
			continue;
		}
		seen.add(accelerator);
		if (binding.when) ignoredWhen.push(label);
		candidates.push({ accelerator, commandId: binding.command, userSettingsLabel: label });
	}

	return { candidates, unsupported, duplicates, ignoredWhen };
}
