import { OperatingSystem } from '../../../../base/common/platform.js';
import type { IKeyboardLayoutDefinition, IKeyboardMapping } from '../../../../platform/keyboardLayout/common/keyboardLayout.js';
import { toKeyboardLayoutDefinitions } from '../common/keymapInfo.js';
import { KeyboardLayoutContribution } from './keyboardLayouts/_.contribution.js';

const layoutPromises = new Map<OperatingSystem, Promise<readonly IKeyboardLayoutDefinition[]>>();

export function loadBuiltinKeyboardLayouts(
	operatingSystem: OperatingSystem,
): Promise<readonly IKeyboardLayoutDefinition[]> {
	const existing = layoutPromises.get(operatingSystem);
	if (existing) {
		return existing;
	}
	const promise = loadPlatformContribution(operatingSystem).then(() => {
		const definitions = KeyboardLayoutContribution.INSTANCE.layoutInfos
			.flatMap((info) => toKeyboardLayoutDefinitions(info))
			.filter((definition) => definition.layout.operatingSystem === operatingSystem);
		return deduplicateLayouts(definitions);
	});
	layoutPromises.set(operatingSystem, promise);
	return promise;
}

export function findMatchingBuiltinLayout(
	browserMapping: IKeyboardMapping,
	definitions: readonly IKeyboardLayoutDefinition[],
): IKeyboardLayoutDefinition | undefined {
	let best: IKeyboardLayoutDefinition | undefined;
	let bestScore = -1;
	for (const definition of definitions) {
		let compared = 0;
		let score = 0;
		for (const [code, observed] of Object.entries(browserMapping)) {
			if (!observed.value) {
				continue;
			}
			const candidate = definition.mapping[code];
			if (!candidate?.value) {
				continue;
			}
			compared += 1;
			if (candidate.value === observed.value) {
				score += 1;
			}
		}
		if (compared < 20 || score !== compared || score <= bestScore) {
			continue;
		}
		best = definition;
		bestScore = score;
	}
	return best;
}

async function loadPlatformContribution(operatingSystem: OperatingSystem): Promise<void> {
	switch (operatingSystem) {
		case OperatingSystem.Windows:
			await import('./keyboardLayouts/layout.contribution.win.js');
			return;
		case OperatingSystem.Macintosh:
			await import('./keyboardLayouts/layout.contribution.darwin.js');
			return;
		case OperatingSystem.Linux:
			await import('./keyboardLayouts/layout.contribution.linux.js');
	}
}

function deduplicateLayouts(
	definitions: readonly IKeyboardLayoutDefinition[],
): readonly IKeyboardLayoutDefinition[] {
	const unique = new Map<string, IKeyboardLayoutDefinition>();
	for (const definition of definitions) {
		if (!unique.has(definition.layout.id)) {
			unique.set(definition.layout.id, definition);
		}
	}
	return Object.freeze([...unique.values()]);
}
