import { addDisposableListener } from '../../../../base/browser/dom.js';
import { getWindows, onDidRegisterWindow, onWillUnregisterWindow, type IRegisteredWindow } from '../../../../base/browser/window.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { raceCancellation, RunOnceScheduler } from '../../../../base/common/async.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { isLinux } from '../../../../base/common/platform.js';
import { localize2 } from '../../../../nls.js';
import { type ICodeEditor, MouseTargetType } from '../../../../editor/browser/editorBrowser.js';
import { EditorAction, EditorContributionInstantiation, registerEditorAction, registerEditorContribution, type ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { EditorOption } from '../../../../editor/common/config/editorOptions.js';
import { Range } from '../../../../editor/common/core/range.js';
import { Handler } from '../../../../editor/common/editorCommon.js';
import { EditorContextKeys } from '../../../../editor/common/editorContextKeys.js';
import { CodeEditorStateFlag, EditorStateCancellationTokenSource } from '../../../../editor/contrib/editorState/browser/editorState.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';

/** Owns selection clipboard synchronization for one desktop editor. */
export class SelectionClipboard extends Disposable {
	public static readonly ID = 'editor.contrib.selectionClipboard';
	private readonly pendingWrite: RunOnceScheduler;

	constructor(private readonly editor: ICodeEditor, @IClipboardService private readonly clipboard: IClipboardService) {
		super();
		this.pendingWrite = this._register(new RunOnceScheduler(() => void this.writeSelection().catch(onUnexpectedError), 100));
		this._register(editor.onDidChangeCursorSelection(event => {
			if (!editor.getOption(EditorOption.selectionClipboard) || event.source === 'restoreState') {
				this.pendingWrite.cancel();
				return;
			}
			this.pendingWrite.schedule();
		}));
		this._register(editor.onDidChangeModel(() => this.pendingWrite.cancel()));
		this._register(editor.onDidChangeConfiguration(event => {
			if (event.hasChanged(EditorOption.selectionClipboard) && !editor.getOption(EditorOption.selectionClipboard)) {
				this.pendingWrite.cancel();
			}
		}));
		let suppressMouseUp = false;
		this._register(addDisposableListener(editor.getContainerDomNode(), 'mousedown', () => { suppressMouseUp = false; }));
		// Pointer selection can consume mouseup before the public editor event sees it.
		this._register(addDisposableListener(editor.getContainerDomNode(), 'mouseup', event => {
			if (event.button === 1 && suppressMouseUp) {
				suppressMouseUp = false;
				event.preventDefault();
			}
		}));
		this._register(editor.onMouseUp(event => {
			if (!event.event.middleButton || !acceptsMiddlePaste(event.target.type)) {
				return;
			}
			// Own middle-click paste so Chromium cannot paste a second copy or bypass the disabled option.
			suppressMouseUp = event.event.browserEvent.type === 'pointerup';
			event.event.preventDefault();
			if (editor.getOption(EditorOption.selectionClipboard)) {
				void pasteSelection(editor, clipboard, true).catch(onUnexpectedError);
			}
		}));
	}

	private async writeSelection(): Promise<void> {
		const model = this.editor.getModel();
		const selections = this.editor.getSelections();
		if (this.isDisposed || !this.editor.getOption(EditorOption.selectionClipboard) || !model || !selections?.length) {
			return;
		}
		let length = 0;
		for (const selection of selections) {
			if (selection.isEmpty()) {
				return;
			}
			length += model.getValueLengthInRange(selection);
			// Avoid expensive transfers while the user is extending a large selection.
			if (length > 65_536) {
				return;
			}
		}
		const ordered = [...selections].sort(Range.compareRangesUsingStarts);
		await this.clipboard.writeText(ordered.map(selection => model.getValueInRange(selection)).join(model.getEOL()), 'selection');
	}
}

function acceptsMiddlePaste(type: MouseTargetType | undefined): boolean {
	return type !== MouseTargetType.CONTENT_WIDGET && type !== MouseTargetType.OVERLAY_WIDGET && type !== MouseTargetType.SCROLLBAR && type !== MouseTargetType.OUTSIDE_EDITOR;
}

class PasteSelectionClipboardAction extends EditorAction {
	constructor() {
		super({
			id: 'editor.action.selectionClipboardPaste',
			label: localize2('actions.pasteSelectionClipboard', 'Paste Selection Clipboard'),
			precondition: EditorContextKeys.writable,
		});
	}

	public override async run(accessor: ServicesAccessor, editor: ICodeEditor): Promise<void> {
		await pasteSelection(editor, accessor.get(IClipboardService));
	}
}

async function pasteSelection(editor: ICodeEditor, clipboard: IClipboardService, requireEnabled = false): Promise<void> {
	if (!editor.hasModel() || editor.getOption(EditorOption.readOnly) || editor.inComposition || requireEnabled && !editor.getOption(EditorOption.selectionClipboard)) {
		return;
	}
	editor.focus();
	using resources = new DisposableStore();
	const request = new EditorStateCancellationTokenSource(editor, CodeEditorStateFlag.Value | CodeEditorStateFlag.Selection);
	resources.add(toDisposable(() => request.dispose(true)));
	resources.add(editor.onDidBlurEditorText(() => request.cancel()));
	resources.add(editor.onDidCompositionStart(() => request.cancel()));
	resources.add(editor.onDidChangeConfiguration(event => {
		if (event.hasChanged(EditorOption.readOnly) && editor.getOption(EditorOption.readOnly) || requireEnabled && event.hasChanged(EditorOption.selectionClipboard) && !editor.getOption(EditorOption.selectionClipboard)) {
			request.cancel();
		}
	}));
	const text = await raceCancellation(clipboard.readText('selection'), request.token);
	if (text && !request.token.isCancellationRequested) {
		editor.trigger('keyboard', Handler.Paste, { text, pasteOnNewLine: false, multicursorText: null, mode: null });
	}
}

class LinuxSelectionClipboardPastePreventer extends Disposable {
	constructor(@IConfigurationService configuration: IConfigurationService) {
		super();
		const listeners = this._register(new DisposableMap<number, IDisposable>());
		const register = (window: IRegisteredWindow): void => {
			listeners.set(window.id, addDisposableListener(window.window.document, 'mouseup', event => {
				if (event.button === 1 && configuration.getValue<boolean>('editor.selectionClipboard') === false) event.preventDefault();
			}));
		};
		for (const window of getWindows()) register(window);
		this._register(onDidRegisterWindow(register));
		this._register(onWillUnregisterWindow(window => listeners.deleteAndDispose(window.id)));
	}
}

if (isLinux) {
	registerWorkbenchContribution('workbench.contrib.linuxSelectionClipboardPastePreventer', WorkbenchPhase.BlockRestore,
		accessor => accessor.get(IInstantiationService).createInstance(LinuxSelectionClipboardPastePreventer));
	registerEditorContribution(SelectionClipboard.ID, SelectionClipboard, EditorContributionInstantiation.Eager);
	registerEditorAction(PasteSelectionClipboardAction);
}
