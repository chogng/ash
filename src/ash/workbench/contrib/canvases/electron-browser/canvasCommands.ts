import { URI } from '../../../../base/common/uri.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ICanvasService, REVEAL_CANVAS_COMMAND_ID, type ICanvasReference } from '../common/canvas.js';

export function registerCanvasCommands(): IDisposable {
	return CommandsRegistry.register(REVEAL_CANVAS_COMMAND_ID, (accessor, value: unknown) => {
		const reference = value as Partial<ICanvasReference> | undefined;
		if (
			!reference ||
			typeof reference.providerId !== 'string' ||
			!URI.isUri(reference.session) ||
			!URI.isUri(reference.chat) ||
			!URI.isUri(reference.canvas)
		) {
			throw new TypeError('Invalid Canvas reference');
		}
		return accessor.get(ICanvasService).revealCanvas(reference as ICanvasReference);
	});
}
