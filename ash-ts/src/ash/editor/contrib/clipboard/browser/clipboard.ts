import { isFirefox } from '../../../../base/browser/browser.js';
import { addDisposableListener, getActiveDocument } from '../../../../base/browser/dom.js';
import { type IKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { isNative } from '../../../../base/common/platform.js';
import * as nls from '../../../../nls.js';
import { MenuId, MenusRegistry } from '../../../../platform/actions/common/actions.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { CopyOptions, generateDataToCopyAndStoreInMemory, InMemoryClipboardMetadataManager } from '../../../browser/controller/editContext/clipboardUtils.js';
import { NativeEditContextRegistry } from '../../../browser/controller/editContext/native/nativeEditContextRegistry.js';
import { type ICodeEditor } from '../../../browser/editorBrowser.js';
import { EditorAction, EditorContributionInstantiation, MultiCommand, registerEditorAction, registerEditorContribution, type Command, type ServicesAccessor } from '../../../browser/editorExtensions.js';
import { ICodeEditorService } from '../../../browser/services/codeEditorService.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import { Selection } from '../../../common/core/selection.js';
import { Handler, type IEditorContribution } from '../../../common/editorCommon.js';
import { EditorContextKeys } from '../../../common/editorContextKeys.js';
import { type ITextModel } from '../../../common/model.js';

const CLIPBOARD_CONTEXT_MENU_GROUP = '9_cutcopypaste';
const supportsCut = isNative || supportsDocumentCommand('cut');
const supportsCopy = isNative || supportsDocumentCommand('copy');
const supportsPaste = typeof navigator !== 'undefined' && navigator.clipboard
	? true
	: supportsDocumentCommand('paste');

function registerCommand<T extends Command>(command: T): T {
	command.register();
	return command;
}

export const CutAction = supportsCut ? registerCommand(new MultiCommand({
	id: 'editor.action.clipboardCutAction',
	precondition: undefined,
	kbOpts: isNative ? {
		primary: KeyMod.CtrlCmd | KeyCode.KeyX,
		win: { primary: KeyMod.CtrlCmd | KeyCode.KeyX, secondary: [KeyMod.Shift | KeyCode.Delete] },
		weight: KeybindingWeight.EditorContrib,
	} : undefined,
	menuOpts: clipboardMenuOptions(nls.localize('actions.clipboard.cutLabel', 'Cut'), 1, true),
})) : undefined;

export const CopyAction = supportsCopy ? registerCommand(new MultiCommand({
	id: 'editor.action.clipboardCopyAction',
	precondition: undefined,
	kbOpts: isNative ? {
		primary: KeyMod.CtrlCmd | KeyCode.KeyC,
		win: { primary: KeyMod.CtrlCmd | KeyCode.KeyC, secondary: [KeyMod.CtrlCmd | KeyCode.Insert] },
		weight: KeybindingWeight.EditorContrib,
	} : undefined,
	menuOpts: clipboardMenuOptions(nls.localize('actions.clipboard.copyLabel', 'Copy'), 2, false),
})) : undefined;

export const PasteAction = supportsPaste ? registerCommand(new MultiCommand({
	id: 'editor.action.clipboardPasteAction',
	precondition: undefined,
	kbOpts: isNative ? {
		primary: KeyMod.CtrlCmd | KeyCode.KeyV,
		win: { primary: KeyMod.CtrlCmd | KeyCode.KeyV, secondary: [KeyMod.Shift | KeyCode.Insert] },
		linux: { primary: KeyMod.CtrlCmd | KeyCode.KeyV, secondary: [KeyMod.Shift | KeyCode.Insert] },
		weight: KeybindingWeight.EditorContrib,
	} : undefined,
	menuOpts: clipboardMenuOptions(nls.localize('actions.clipboard.pasteLabel', 'Paste'), 4, true),
})) : undefined;

MenusRegistry.appendMenuItem(MenuId.MenubarEditMenu, {
	submenu: MenuId.MenubarCopy,
	title: nls.localize2('copy as', 'Copy As'),
	group: '2_ccp',
	order: 3,
});
MenusRegistry.appendMenuItem(MenuId.EditorContext, {
	submenu: MenuId.EditorContextCopy,
	title: nls.localize2('copy as', 'Copy As'),
	group: CLIPBOARD_CONTEXT_MENU_GROUP,
	order: 3,
});

registerExecCommandImpl(CutAction, 'cut');
registerExecCommandImpl(CopyAction, 'copy');

if (PasteAction) {
	PasteAction.addImplementation(10_000, 'code-editor', accessor => {
		const editor = accessor.get(ICodeEditorService).getFocusedCodeEditor();
		if (!editor?.hasModel() || !editor.hasTextFocus()) return false;
		return pasteIntoEditor(editor, accessor.get(IClipboardService));
	});
	PasteAction.addImplementation(0, 'generic-dom', () => executeDocumentCommand('paste'));
}

async function pasteIntoEditor(editor: ICodeEditor, clipboardService: IClipboardService): Promise<void> {
	if (editor.inComposition) return;
	const model = editor.getModel();
	const selections = editor.getSelections();
	if (!model || !selections) return;
	const version = model.getVersionId();
	NativeEditContextRegistry.get(editor.getId())?.handleWillPaste();
	const text = await clipboardService.readText();
	if (!text || !canApplyClipboardEdit(editor, model, version, selections)) return;
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
		CopyOptions.forceCopyWithSyntaxHighlighting = true;
		try {
			editor.focus();
			await executeEditorCopy(editor, accessor.get(IClipboardService));
		} finally {
			CopyOptions.forceCopyWithSyntaxHighlighting = false;
		}
	}
}

if (supportsCopy) registerEditorAction(ExecCommandCopyWithSyntaxHighlightingAction);

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
	target.addImplementation(10_000, 'code-editor', accessor => {
		const editor = accessor.get(ICodeEditorService).getFocusedCodeEditor();
		if (!editor?.hasModel() || !editor.hasTextFocus()) return false;
		if (!editor.getOption(EditorOption.emptySelectionClipboard) && editor.getSelection()?.isEmpty()) return true;
		return executeEditorClipboardCommand(editor, accessor.get(IClipboardService), browserCommand);
	});
	target.addImplementation(0, 'generic-dom', () => executeDocumentCommand(browserCommand));
}

async function executeEditorClipboardCommand(editor: ICodeEditor, clipboardService: IClipboardService, browserCommand: 'cut' | 'copy'): Promise<void> {
	NativeEditContextRegistry.get(editor.getId())?.handleWillCopy();
	if (browserCommand === 'copy') {
		await executeEditorCopy(editor, clipboardService);
		return;
	}
	if (editor.inComposition) return;
	const model = editor.getModel();
	const selections = editor.getSelections();
	if (!model || !selections) return;
	const version = model.getVersionId();
	const document = editor.getContainerDomNode().ownerDocument;
	CopyOptions.cutEventHasFired = false;
	if (typeof document.execCommand === 'function') document.execCommand('cut');
	if (CopyOptions.cutEventHasFired) return;
	await writeEditorText(editor, clipboardService);
	if (!canApplyClipboardEdit(editor, model, version, selections)) return;
	editor.trigger('keyboard', Handler.Cut, undefined);
}

function canApplyClipboardEdit(editor: ICodeEditor, model: ITextModel, version: number, selections: Selection[]): boolean {
	return editor.getModel() === model
		&& editor.hasTextFocus()
		&& !editor.inComposition
		&& model.getVersionId() === version
		&& Selection.selectionsArrEqual(selections, editor.getSelections() ?? []);
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

function supportsDocumentCommand(command: 'cut' | 'copy' | 'paste'): boolean {
	return typeof document !== 'undefined'
		&& typeof document.queryCommandSupported === 'function'
		&& document.queryCommandSupported(command);
}

class ClipboardKeybindings extends Disposable implements IEditorContribution {
	constructor(private readonly editor: ICodeEditor) {
		super();
		this._register(editor.onKeyDown(event => this.onKeyDown(event)));
	}

	private onKeyDown(event: IKeyboardEvent): void {
		if (isNative || event.browserEvent.defaultPrevented || event.isComposing || !this.editor.hasTextFocus()) return;
		if (!NativeEditContextRegistry.get(this.editor.getId())) return;
		if (event.altKey || event.shiftKey || event.ctrlKey === event.metaKey) return;
		const key = event.key.toLowerCase();
		if ((key === 'c' && !CopyAction) || (key === 'x' && !CutAction) || (key === 'v' && !PasteAction)) return;
		if (key !== 'c' && key !== 'x' && key !== 'v') return;
		if (key !== 'v' && !this.editor.getOption(EditorOption.emptySelectionClipboard) && this.editor.getSelection()?.isEmpty()) return;
		event.stop();
		const clipboardService = this.editor.invokeWithinContext(accessor => accessor.get(IClipboardService));
		const operation = key === 'v'
			? pasteIntoEditor(this.editor, clipboardService)
			: executeEditorClipboardCommand(this.editor, clipboardService, key === 'c' ? 'copy' : 'cut');
		void operation.catch(onUnexpectedError);
	}
}

registerEditorContribution('editor.contrib.clipboard', ClipboardKeybindings, EditorContributionInstantiation.Eager);
