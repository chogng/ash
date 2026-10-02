import { parseKeybinding } from '../../../../base/common/keybindingParser.js';
import { resolveKeybinding } from '../../../../base/common/keybindings.js';
import { OperatingSystem } from '../../../../base/common/platform.js';
import { toElectronAccelerator } from '../../../../platform/keybinding/common/electronAccelerator.js';
import type { IKeybindingEntry } from '../../../../platform/keybinding/common/keybindingsResource.js';
import type { INativeSystemWideKeybinding } from '../../../../platform/native/common/nativeHost.js';

export interface ISystemWideKeybindingSelection {
	readonly candidates: readonly INativeSystemWideKeybinding[];
	readonly unsupported: readonly ISystemWideKeybindingRejection[];
	readonly duplicates: readonly ISystemWideKeybindingRejection[];
	readonly ignoredWhen: readonly ISystemWideKeybindingRejection[];
}

export interface ISystemWideKeybindingRejection {
	readonly commandId: string;
	readonly userSettingsLabel: string;
}

/** Selects explicit user shortcuts that Electron can register with the operating system. */
export function selectSystemWideKeybindings(bindings: readonly IKeybindingEntry[], operatingSystem: OperatingSystem): ISystemWideKeybindingSelection {
	const candidates: INativeSystemWideKeybinding[] = [];
	const unsupported: ISystemWideKeybindingRejection[] = [];
	const duplicates: ISystemWideKeybindingRejection[] = [];
	const ignoredWhen: ISystemWideKeybindingRejection[] = [];
	const seen = new Set<string>();

	for (const binding of bindings) {
		if (binding.systemWide !== true || !binding.command) continue;
		const key = operatingSystem === OperatingSystem.Macintosh ? binding.mac : operatingSystem === OperatingSystem.Windows ? binding.win : binding.linux;
		const label = key === undefined ? binding.key : key;
		if (label === null) continue;
		const rejection = { commandId: binding.command, userSettingsLabel: label };
		const parsed = parseKeybinding(label);
		const accelerator = parsed ? toElectronAccelerator(resolveKeybinding(parsed, operatingSystem)) : undefined;
		if (!accelerator) {
			unsupported.push(rejection);
			continue;
		}
		if (seen.has(accelerator)) {
			duplicates.push(rejection);
			continue;
		}
		seen.add(accelerator);
		if (binding.when) ignoredWhen.push(rejection);
		candidates.push({ accelerator, commandId: binding.command, args: binding.args, userSettingsLabel: label });
	}

	return { candidates, unsupported, duplicates, ignoredWhen };
}
