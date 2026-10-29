import type { MessageBoxOptions } from '../../../base/parts/sandbox/common/electronTypes.js';
import { release } from 'node:os';

export function massageMessageBoxOptions(
	options: MessageBoxOptions,
	platform: NodeJS.Platform = process.platform,
): { options: MessageBoxOptions; buttonIndices: readonly number[]; } {
	const buttons = [...options.buttons ?? []];
	const buttonIndices = buttons.map((_, index) => index);
	const originalDefault = options.defaultId ?? 0;
	const originalCancel = options.cancelId ?? buttons.length - 1;
	const legacyMacOrder = platform === 'darwin' && Number.parseInt(release(), 10) < 24;
	if (buttons.length > 1 && originalCancel >= 0 && (platform === 'linux' || legacyMacOrder) && originalCancel !== 1) {
		buttons.splice(1, 0, buttons.splice(originalCancel, 1)[0]!);
		buttonIndices.splice(1, 0, buttonIndices.splice(originalCancel, 1)[0]!);
	}
	if (platform === 'linux') {
		buttons.reverse();
		buttonIndices.reverse();
	}
	return {
		options: {
			...options,
			...(buttons.length ? {
				buttons,
				defaultId: buttonIndices.indexOf(originalDefault),
				cancelId: buttonIndices.indexOf(originalCancel),
			} : {}),
			noLink: true,
		},
		buttonIndices,
	};
}
