import { addDisposableListener, stopEvent } from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { registerTextEditorCapabilityContribution } from '../../../browser/editorExtensions.js';
import { type View } from '../../../browser/view.js';
import { CursorMoveCommands } from '../../../common/cursor/cursorMoveCommands.js';
import { type IViewModel } from '../../../common/viewModel.js';
import { CursorChangeReason } from '../../../common/cursorEvents.js';

/** Routes the line-expansion command through the text editor input owner. */
class LineSelectionController extends Disposable {
	constructor(input: HTMLElement, private readonly viewport: View, private readonly viewModel: IViewModel) {
		super();
		if (viewport.textModel !== viewModel.model) throw new TypeError('Line selection dependencies must share one text model');
		this._register(addDisposableListener(input, 'keydown', event => {
			if (event.defaultPrevented || event.isComposing || event.getModifierState('AltGraph') || (!event.ctrlKey && !event.metaKey) || event.shiftKey || event.altKey || event.key.toLowerCase() !== 'l') return;
			stopEvent(event);
			const next = CursorMoveCommands.expandLineSelection(viewModel, viewModel.getCursorStates());
			viewModel.setCursorStates('keyboard', CursorChangeReason.Explicit, next);
			viewport.revealPosition(viewModel.getPrimaryCursorState().modelState.position);
		}));
	}
}

registerTextEditorCapabilityContribution({
	id: 'editor.contrib.lineSelection',
	install: context => {
		if (context.kind !== 'text') return;
		context.register(new LineSelectionController(context.controller.element, context.view, context.viewModel));
	},
});
