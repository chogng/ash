import { onActivate } from '../../../registration.js';
import { isFirefox } from '../../../../../../src/ash/base/browser/browser.js';
import { addDisposableListener, getActiveDocument, getActiveElement, getActiveWindow, getWindow, getWindowId, isEditableElement } from '../../../../../../src/ash/base/browser/dom.js';
import { type IKeyboardEvent } from '../../../../../../src/ash/base/browser/keyboardEvent.js';
import { raceCancellation } from '../../../../../../src/ash/base/common/async.js';
import { type CancellationToken } from '../../../../../../src/ash/base/common/cancellation.js';
import { onUnexpectedError } from '../../../../../../src/ash/base/common/errors.js';
import { KeyCode, KeyMod } from '../../../../../../src/ash/base/common/keyCodes.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../../src/ash/base/common/lifecycle.js';
import { isNative } from '../../../../../../src/ash/base/common/platform.js';
import * as nls from '../../../../../../src/ash/nls.js';
import { MenuId, MenusRegistry } from '../../../../../../src/ash/platform/actions/common/actions.js';
import { IClipboardService } from '../../../../../../src/ash/platform/clipboard/common/clipboardService.js';
import { KeybindingWeight } from '../../../../../../src/ash/platform/keybinding/common/keybindingsRegistry.js';
import { CopyOptions, generateDataToCopyAndStoreInMemory, InMemoryClipboardMetadataManager } from '../../../../../../src/ash/editor/browser/controller/editContext/clipboardUtils.js';
import { NativeEditContextRegistry } from '../../../../../../src/ash/editor/browser/controller/editContext/native/nativeEditContextRegistry.js';
import { type ICodeEditor } from '../../../../../../src/ash/editor/browser/editorBrowser.js';
import { EditorAction, EditorContributionInstantiation, MultiCommand, registerEditorAction, registerEditorContribution, type Command, type ServicesAccessor } from '../../../registration.js';
import { ICodeEditorService } from '../../../../../../src/ash/editor/browser/services/codeEditorService.js';
import { EditorOption } from '../../../../../../src/ash/editor/common/config/editorOptions.js';
import { Handler, type IEditorContribution } from '../../../../../../src/ash/editor/common/editorCommon.js';
import { EditorContextKeys } from '../../../../../../src/ash/editor/common/editorContextKeys.js';
import { CopyPasteController } from '../../dropOrPasteInto/browser/copyPasteController.js';
import { CodeEditorStateFlag, EditorStateCancellationTokenSource } from '../../editorState/browser/editorState.js';

const CLIPBOARD_CONTEXT_MENU_GROUP = '9_cutcopypaste';

function registerCommand<T extends Command>(command: T): T {
	onActivate(() => command.register());
	return command;
}

// Default shortcuts belong to editor text; terminals and native inputs own their keyboard handling.
export const CutAction = registerCommand(new MultiCommand({
	id: 'editor.action.clipboardCutAction',
	precondition: undefined,
	kbOpts: isNative ? {
		primary: KeyMod.CtrlCmd | KeyCode.KeyX,
		win: { primary: KeyMod.CtrlCmd | KeyCode.KeyX, secondary: [KeyMod.Shift | KeyCode.Delete] },
		weight: KeybindingWeight.EditorContrib,
		kbExpr: EditorContextKeys.textInputFocus.isEqualTo(true),
	} : undefined,
	menuOpts: clipboardMenuOptions(nls.localize('actions.clipboard.cutLabel', 'Cut'), 1, true),
}));

export const CopyAction = registerCommand(new MultiCommand({
	id: 'editor.action.clipboardCopyAction',
	precondition: undefined,
	kbOpts: isNative ? {
		primary: KeyMod.CtrlCmd | KeyCode.KeyC,
		win: { primary: KeyMod.CtrlCmd | KeyCode.KeyC, secondary: [KeyMod.CtrlCmd | KeyCode.Insert] },
		weight: KeybindingWeight.EditorContrib,
		kbExpr: EditorContextKeys.textInputFocus.isEqualTo(true),
	} : undefined,
	menuOpts: clipboardMenuOptions(nls.localize('actions.clipboard.copyLabel', 'Copy'), 2, false),
}));

export const PasteAction = registerCommand(new MultiCommand({
	id: 'editor.action.clipboardPasteAction',
	precondition: undefined,
	kbOpts: isNative ? {
		primary: KeyMod.CtrlCmd | KeyCode.KeyV,
		win: { primary: KeyMod.CtrlCmd | KeyCode.KeyV, secondary: [KeyMod.Shift | KeyCode.Insert] },
		linux: { primary: KeyMod.CtrlCmd | KeyCode.KeyV, secondary: [KeyMod.Shift | KeyCode.Insert] },
		weight: KeybindingWeight.EditorContrib,
		kbExpr: EditorContextKeys.textInputFocus.isEqualTo(true),
	} : undefined,
	menuOpts: clipboardMenuOptions(nls.localize('actions.clipboard.pasteLabel', 'Paste'), 4, true),
}));

onActivate(() => MenusRegistry.appendMenuItem(MenuId.MenubarEditMenu, {
	submenu: MenuId.MenubarCopy,
	title: nls.localize2('copy as', 'Copy As'),
	group: '2_ccp',
	order: 3,
}));
onActivate(() => MenusRegistry.appendMenuItem(MenuId.EditorContext, {
	submenu: MenuId.EditorContextCopy,
	title: nls.localize2('copy as', 'Copy As'),
	group: CLIPBOARD_CONTEXT_MENU_GROUP,
	order: 3,
}));

registerExecCommandImpl(CutAction, 'cut');
registerExecCommandImpl(CopyAction, 'copy');

if (PasteAction) {
	onActivate(() => PasteAction.addImplementation(10_000, 'code-editor', accessor => {
		const editor = getClipboardEditor(accessor);
		if (!editor) return false;
		return pasteIntoEditor(editor, accessor.get(IClipboardService));
	}));
	onActivate(() => PasteAction.addImplementation(0, 'generic-dom', accessor => {
		const windowId = getWindowId(getActiveWindow());
		return windowId === undefined ? false : accessor.get(IClipboardService).triggerPaste(windowId) ?? false;
	}));
}

async function pasteIntoEditor(editor: ICodeEditor, clipboardService: IClipboardService): Promise<void> {
	if (editor.inComposition || editor.getOption(EditorOption.readOnly) || !editor.hasModel()) return;
	editor.focus();
	using resources = new DisposableStore();
	const token = createClipboardCancellation(editor, resources);
	const windowId = getWindowId(getWindow(editor.getContainerDomNode()));
	const triggered = windowId === undefined ? undefined : clipboardService.triggerPaste(windowId);
	if (triggered !== undefined) {
		await raceCancellation(triggered, token);
		if (!token.isCancellationRequested) await CopyPasteController.get(editor)?.finishedPaste();
		return;
	}
	NativeEditContextRegistry.get(editor.getId())?.handleWillPaste();
	const text = await raceCancellation(clipboardService.readText(), token);
	if (!text || token.isCancellationRequested) return;
	const metadata = InMemoryClipboardMetadataManager.INSTANCE.get(text);
	editor.trigger('keyboard', Handler.Paste, {
		text,
		pasteOnNewLine: editor.getOption(EditorOption.emptySelectionClipboard) && !!metadata?.isFromEmptySelection,
		multicursorText: metadata?.multicursorText ?? null,
		mode: metadata?.mode ?? null,
	});
}

class ExecCommandCopyWithSyntaxHighlightingAction extends EditorAction {
	constructor() {
		super({
			id: 'editor.action.clipboardCopyWithSyntaxHighlightingAction',
			label: nls.localize2('actions.clipboard.copyWithSyntaxHighlightingLabel', 'Copy with Syntax Highlighting'),
			menuOpts: [MenuId.EditorContextCopy, MenuId.MenubarCopy].map(menuId => ({
				menuId,
				group: '1_copy',
				order: 1,
				title: nls.localize('actions.clipboard.copyWithSyntaxHighlightingLabel', 'Copy with Syntax Highlighting'),
			})),
			precondition: undefined,
			kbOpts: {
				kbExpr: EditorContextKeys.textInputFocus.isEqualTo(true),
				primary: 0,
				weight: KeybindingWeight.EditorContrib,
			},
		});
	}

	public async run(accessor: ServicesAccessor, editor: ICodeEditor): Promise<void> {
		if (!editor.hasModel()) return;
		if (!editor.getOption(EditorOption.emptySelectionClipboard) && editor.getSelection()?.isEmpty()) return;
		const previous = CopyOptions.forceCopyWithSyntaxHighlighting;
		CopyOptions.forceCopyWithSyntaxHighlighting = true;
		try {
			editor.focus();
			// Restore the option before waiting for the asynchronous clipboard write.
			return executeEditorCopy(editor, accessor.get(IClipboardService));
		} finally {
			CopyOptions.forceCopyWithSyntaxHighlighting = previous;
		}
	}
}

registerEditorAction(ExecCommandCopyWithSyntaxHighlightingAction);

function clipboardMenuOptions(title: string, order: number, writable: boolean) {
	const when = writable ? EditorContextKeys.writable : undefined;
	return [{
		menuId: MenuId.MenubarEditMenu,
		group: '2_ccp',
		title,
		order,
	}, {
		menuId: MenuId.EditorContext,
		group: CLIPBOARD_CONTEXT_MENU_GROUP,
		title,
		when,
		order,
	}, {
		menuId: MenuId.CommandPalette,
		group: '',
		title,
		order: 1,
	}, {
		menuId: MenuId.SimpleEditorContext,
		group: CLIPBOARD_CONTEXT_MENU_GROUP,
		title,
		when,
		order,
	}];
}

function registerExecCommandImpl(target: MultiCommand | undefined, browserCommand: 'cut' | 'copy'): void {
	if (!target) return;
	onActivate(() => target.addImplementation(10_000, 'code-editor', accessor => {
		const editor = getClipboardEditor(accessor);
		if (!editor) return false;
		if (!editor.getOption(EditorOption.emptySelectionClipboard) && editor.getSelection()?.isEmpty()) return true;
		return executeEditorClipboardCommand(editor, accessor.get(IClipboardService), browserCommand);
	}));
	onActivate(() => target.addImplementation(0, 'generic-dom', () => executeDocumentCommand(browserCommand)));
}

function getClipboardEditor(accessor: ServicesAccessor): ICodeEditor | null {
	const editors = accessor.get(ICodeEditorService);
	const editor = editors.getFocusedCodeEditor() ?? editors.getActiveCodeEditor();
	if (!editor?.hasModel()) return null;
	const activeElement = getActiveElement();
	if (!editor.hasTextFocus() && activeElement && isEditableElement(activeElement)) return null;
	return editor;
}

async function executeEditorClipboardCommand(editor: ICodeEditor, clipboardService: IClipboardService, browserCommand: 'cut' | 'copy'): Promise<void> {
	if (browserCommand === 'cut' && (editor.inComposition || editor.getOption(EditorOption.readOnly) || !editor.hasModel())) return;
	editor.focus();
	NativeEditContextRegistry.get(editor.getId())?.handleWillCopy();
	if (browserCommand === 'copy') {
		await executeEditorCopy(editor, clipboardService);
		return;
	}
	using resources = new DisposableStore();
	const token = createClipboardCancellation(editor, resources);
	const document = editor.getContainerDomNode().ownerDocument;
	CopyOptions.cutEventHasFired = false;
	if (typeof document.execCommand === 'function') document.execCommand('cut');
	if (CopyOptions.cutEventHasFired) return;
	if (token.isCancellationRequested) return;
	await raceCancellation(writeEditorText(editor, clipboardService), token);
	if (token.isCancellationRequested) return;
	editor.trigger('keyboard', Handler.Cut, undefined);
}

function createClipboardCancellation(editor: ICodeEditor, resources: DisposableStore): CancellationToken {
	const request = new EditorStateCancellationTokenSource(editor, CodeEditorStateFlag.Value | CodeEditorStateFlag.Selection);
	resources.add(toDisposable(() => request.dispose(true)));
	resources.add(editor.onDidBlurEditorText(() => request.cancel()));
	resources.add(editor.onDidCompositionStart(() => request.cancel()));
	resources.add(editor.onDidChangeConfiguration(event => {
		if (event.hasChanged(EditorOption.readOnly) && editor.getOption(EditorOption.readOnly)) {
			request.cancel();
		}
	}));
	return request.token;
}

async function executeEditorCopy(editor: ICodeEditor, clipboardService: IClipboardService): Promise<void> {
	CopyOptions.electronBugWorkaroundCopyEventHasFired = false;
	const document = editor.getContainerDomNode().ownerDocument;
	if (typeof document.execCommand === 'function') {
		// EditContext may send the command's copy event to the document body.
		using copy = addDisposableListener<ClipboardEvent>(document, 'copy', event => {
			if (CopyOptions.electronBugWorkaroundCopyEventHasFired || event.defaultPrevented || !editor.hasTextFocus()) return;
			const viewModel = editor._getViewModel();
			if (!viewModel || !event.clipboardData) return;
			const { dataToCopy, metadata } = generateDataToCopyAndStoreInMemory(viewModel, undefined, isFirefox);
			event.clipboardData.setData('text/plain', dataToCopy.text);
			if (dataToCopy.html) event.clipboardData.setData('text/html', dataToCopy.html);
			event.clipboardData.setData('vscode-editor-data', JSON.stringify(metadata));
			event.preventDefault();
			CopyOptions.electronBugWorkaroundCopyEventHasFired = true;
		});
		document.execCommand('copy');
	}
	if (!CopyOptions.electronBugWorkaroundCopyEventHasFired) await writeEditorText(editor, clipboardService);
}

async function writeEditorText(editor: ICodeEditor, clipboardService: IClipboardService): Promise<void> {
	const viewModel = editor._getViewModel();
	if (!viewModel) return;
	const { dataToCopy } = generateDataToCopyAndStoreInMemory(viewModel, undefined, isFirefox);
	await clipboardService.writeText(dataToCopy.text);
}

function executeDocumentCommand(command: 'cut' | 'copy' | 'paste'): boolean {
	const document = getActiveDocument();
	return typeof document.execCommand === 'function' && document.execCommand(command);
}


class ClipboardKeybindings extends Disposable implements IEditorContribution {
	constructor(private readonly editor: ICodeEditor, @IClipboardService private readonly clipboardService: IClipboardService) {
		super();
		this._register(editor.onKeyDown(event => this.onKeyDown(event)));
	}

	private onKeyDown(event: IKeyboardEvent): void {
		if (isNative || event.browserEvent.defaultPrevented || event.isComposing || !this.editor.hasTextFocus()) return;
		if (!NativeEditContextRegistry.get(this.editor.getId())) return;
		if (event.altKey || event.shiftKey || event.ctrlKey === event.metaKey) return;
		const key = event.key.toLowerCase();
		// The browser's paste shortcut delivers HTML and files to the input adapter.
		// Preventing its default action would replace that event with a text-only read.
		if (key !== 'c' && key !== 'x') return;
		if ((key === 'c' && !CopyAction) || (key === 'x' && !CutAction)) return;
		if (!this.editor.getOption(EditorOption.emptySelectionClipboard) && this.editor.getSelection()?.isEmpty()) return;
		event.stop();
		const operation = executeEditorClipboardCommand(this.editor, this.clipboardService, key === 'c' ? 'copy' : 'cut');
		void operation.catch(onUnexpectedError);
	}
}

registerEditorContribution('editor.contrib.clipboard', ClipboardKeybindings, EditorContributionInstantiation.Eager);
