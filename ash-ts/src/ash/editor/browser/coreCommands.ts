import { addDisposableListener, stopEvent } from "../../base/browser/dom.js";
import { type IDisposable } from "../../base/common/lifecycle.js";
import { type TextModel } from "../common/model/textModel.js";
import { CursorMoveCommands } from '../common/cursor/cursorMoveCommands.js';
import { CursorChangeReason } from '../common/cursorEvents.js';
import { type IViewModel } from '../common/viewModel.js';
import { registerTextEditorCapabilityContribution, SelectAllCommand } from "./editorExtensions.js";
import { ICodeEditorService } from './services/codeEditorService.js';
import { type View } from "./view.js";

export const EditorCoreCommandId = Object.freeze({
	selectAll: "editor.action.selectAll",
});

SelectAllCommand.addImplementation(100, 'code-editor', accessor => {
	const editor = accessor.get(ICodeEditorService).getFocusedCodeEditor();
	const model = editor?.getModel();
	if (!editor || !model || !editor.hasTextFocus()) { return false; }
	const range = model.getFullModelRange();
	editor.setSelection(range, 'keyboard');
	return true;
});

export const enum NavigationCommandRevealType {
	Regular = 0,
	Minimal = 1,
	None = 2,
}

export interface CoreTextEditorCommandContext {
	readonly model: TextModel;
	readonly viewport: View;
	readonly viewModel: IViewModel;
}

/** Executes the built-in text-editor Select All command. */
export function selectAll(context: CoreTextEditorCommandContext): void {
	if (context.model !== context.viewport.textModel || context.model !== context.viewModel.model) {
		throw new TypeError("Editor core command dependencies must share one text model");
	}
	context.viewModel.setCursorStates('keyboard', CursorChangeReason.Explicit, [
		CursorMoveCommands.selectAll(context.viewModel, context.viewModel.getPrimaryCursorState()),
	]);
	context.viewport.revealPosition(context.viewModel.getPrimaryCursorState().modelState.position);
}

/** Installs text-editor core keybindings for one editor lifetime. */
export function installCoreTextEditorCommands(
	input: HTMLElement,
	viewport: View,
	viewModel: IViewModel,
): IDisposable {
	if (viewport.textModel !== viewModel.model) {
		throw new TypeError("Editor core command dependencies must share one text model");
	}
	return addDisposableListener(input, "keydown", event => {
		if (event.defaultPrevented || event.isComposing || event.getModifierState("AltGraph")) return;
		if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "a") {
			stopEvent(event);
			selectAll({ model: viewport.textModel, viewport, viewModel });
		}
	});
}

registerTextEditorCapabilityContribution({
	id: EditorCoreCommandId.selectAll,
	install: context => {
		if (context.kind !== "text") return;
		context.register(installCoreTextEditorCommands(context.controller.element, context.view, context.viewModel));
	},
});
