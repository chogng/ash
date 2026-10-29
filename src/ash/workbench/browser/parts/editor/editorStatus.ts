import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { IFileTextModelService } from '../../../services/textmodelResolver/common/textModelResourceService.js';
import { EncodingMode } from '../../../services/textfile/common/textfiles.js';
import { getEncodingLabel, SUPPORTED_ENCODINGS } from '../../../services/textfile/common/encoding.js';
import { IWorkingCopyService } from '../../../services/workingCopy/common/workingCopyService.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { Schemas } from '../../../../base/common/network.js';
import { isEditorPaneWithStatus } from '../../../common/editor.js';
import './media/editorstatus.css';
import { addDisposableListener, h, isHTMLElement } from '../../../../base/browser/dom.js';
import {
	Disposable,
	DisposableMap,
	DisposableStore,
	MutableDisposable,
	toDisposable,
	type IDisposable,
} from '../../../../base/common/lifecycle.js';
import { IAccessibilityService } from '../../../../platform/accessibility/common/accessibility.js';
import { localize, localize2 } from '../../../../nls.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import type { ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { EditorOption } from '../../../../editor/common/config/editorOptions.js';
import { EndOfLineSequence, type ITextModel } from '../../../../editor/common/model.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { Action2 } from '../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import type { IWorkbenchContribution } from '../../../common/contributions.js';

import type { IEditorPart } from './editorPart.js';
import {
	StatusbarAlignment,
	type IStatusbarEntry,
	type IStatusbarEntryAccessor,
	type IStatusbarService,
} from '../../../services/statusbar/browser/statusbar.js';

/** Projects the active editor's cursor, format, language, and save state. */
export class EditorStatusContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.editorStatus';

	private readonly cursor = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly indentation = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly eol = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly encoding = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly language = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly state = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly screenReaderMode = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly explanation = this._register(new MutableDisposable<DisposableStore>());
	private readonly paneListeners = this._register(new DisposableStore());
	private readonly controlListeners = this._register(new DisposableStore());
	private readonly pickerResources = this._register(new DisposableStore());
	private readonly editorListeners = this._register(new DisposableMap<ICodeEditor, IDisposable>());
	private activeControl: ICodeEditor | undefined;

	constructor(
		private readonly editorPart: IEditorPart,
		private readonly statusbar: IStatusbarService,
		@IAccessibilityService private readonly accessibility: IAccessibilityService,
		@ICodeEditorService private readonly codeEditors: ICodeEditorService,
		@ICommandService private readonly commands: ICommandService,
		@ILanguageService private readonly languages: ILanguageService,
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@IFileTextModelService private readonly models: IFileTextModelService,
	) {
		super();
		this._register(codeEditors.onCodeEditorAdd(editor => this.trackEditor(editor)));
		this._register(
			codeEditors.onCodeEditorRemove(editor => {
				this.editorListeners.deleteAndDispose(editor);
				if (editor === this.activeControl) {
					this.update();
				}
			}),
		);
		for (const editor of codeEditors.listCodeEditors()) {
			this.trackEditor(editor);
		}
		this._register(models.onDidChangeEncoding(() => this.updateEntries()));
		this._register(languages.onDidChange(() => this.updateEntries()));
		this._register(editorPart.onDidChangeEditors(() => this.update()));
		this._register(accessibility.onDidChangeScreenReaderOptimized(() => this.updateScreenReaderMode()));
		this.update();
		this.updateScreenReaderMode();
	}

	private updateScreenReaderMode(): void {
		if (!this.accessibility.isScreenReaderOptimized()) {
			this.screenReaderMode.clear();
			this.explanation.clear();
			return;
		}
		this.setEntry(
			this.screenReaderMode,
			{
				text: localize('status.editor.screenReaderMode', 'Screen Reader Mode'),
				ariaLabel: localize('status.editor.screenReaderAria', 'Screen reader mode enabled. Open explanation'),
				tooltip: localize(
					'status.editor.screenReaderTooltip',
					'Screen reader mode is enabled. Open explanation',
				),
				run: () => this.showScreenReaderExplanation(),
			},
			'ash.status.editor.screenReaderMode',
			100,
		);
	}

	private showScreenReaderExplanation(): void {
		if (this.explanation.value) return;
		const doc = this.editorPart.domNode.ownerDocument;
		const previousFocus = isHTMLElement(doc.activeElement) ? doc.activeElement : undefined;
		const resources = new DisposableStore();
		const dialog = h(doc, 'section');
		dialog.className = 'ash-screen-reader-explanation';
		dialog.setAttribute('role', 'dialog');
		dialog.setAttribute('aria-modal', 'true');
		dialog.setAttribute('aria-labelledby', 'ash-screen-reader-explanation-title');
		const heading = h(doc, 'h2');
		heading.id = 'ash-screen-reader-explanation-title';
		heading.textContent = localize('status.editor.screenReaderHeading', 'Screen reader mode is on');
		const details = h(doc, 'p');
		details.textContent = localize(
			'status.editor.screenReaderDetails',
			'Ash has adjusted editor interactions for a screen reader. You can change this in Settings under Screen reader optimization.',
		);
		const close = h(doc, 'button');
		close.type = 'button';
		close.textContent = localize('status.editor.close', 'Close');
		dialog.append(heading, details, close);
		doc.body.append(dialog);
		resources.add(
			toDisposable(() => {
				dialog.remove();
				if (previousFocus?.isConnected) previousFocus.focus();
			}),
		);
		resources.add(addDisposableListener(close, 'click', () => this.explanation.clear()));
		resources.add(
			addDisposableListener(dialog, 'keydown', (event: KeyboardEvent) => {
				if (event.key === 'Tab') {
					event.preventDefault();
					close.focus();
					return;
				}
				if (event.key !== 'Escape') return;
				event.preventDefault();
				this.explanation.clear();
			}),
		);
		this.explanation.value = resources;
		close.focus();
	}

	private trackEditor(editor: ICodeEditor): void {
		this.editorListeners.set(
			editor,
			editor.onDidFocusEditorText(() => this.update()),
		);
	}

	private update(): void {
		this.paneListeners.clear();
		this.controlListeners.clear();
		const pane = this.editorPart.activePane;
		const control = pane?.getControl();
		const registered = this.codeEditors.listCodeEditors();
		const diff = this.codeEditors.listDiffEditors().find(editor => editor === control);
		if (diff) {
			const original = diff.getOriginalEditor();
			const modified = diff.getModifiedEditor();
			// Retain the selected side while focus moves to a status action or picker.
			const previous = this.activeControl;
			this.activeControl = original.hasTextFocus()
				? original
				: modified.hasTextFocus()
					? modified
					: previous === original || previous === modified
						? previous
						: modified;
		} else {
			this.activeControl = registered.find(editor => editor === control);
		}
		if (isEditorPaneWithStatus(pane)) {
			this.paneListeners.add(pane.onDidChangeStatus(() => this.updateEntries()));
		}
		if (pane?.workingCopy) {
			this.paneListeners.add(pane.workingCopy.onDidChangeDirty(() => this.updateEntries()));
			this.paneListeners.add(pane.workingCopy.onDidChangeExternalChange(() => this.updateEntries()));
		}
		const editor = this.activeControl;
		if (editor) {
			this.controlListeners.add(editor.onDidChangeModel(() => this.update()));
			this.controlListeners.add(editor.onDidChangeCursorSelection(() => this.updateEntries()));
			this.controlListeners.add(editor.onDidChangeConfiguration(() => this.updateEntries()));
			const model = editor.getModel();
			if (model) {
				this.controlListeners.add(model.onDidChangeOptions(() => this.updateEntries()));
				this.controlListeners.add(model.onDidChangeLanguage(() => this.updateEntries()));
				this.controlListeners.add(model.onDidChangeContent(() => this.updateEntries()));
			}
		}
		this.updateEntries();
	}

	private updateEntries(): void {
		const input = this.editorPart.activeInput;
		const pane = this.editorPart.activePane;
		const editor = this.activeControl;
		const model = editor?.getModel();
		const status = input && isEditorPaneWithStatus(pane) ? pane.getStatus() : undefined;
		const selections = editor?.getSelections();
		const position = selections?.[0]?.getPosition();
		const line = position?.lineNumber ?? status?.lineNumber;
		const column = position && editor ? editor.getStatusbarColumn(position) : status?.columnNumber;
		const count = selections?.length ?? status?.selectionCount ?? 1;
		const selected =
			model && selections
				? selections.reduce((total, selection) => total + model.getValueLengthInRange(selection), 0)
				: 0;
		let cursorText =
			line !== undefined && column !== undefined
				? localize('status.editor.position', 'Ln {0}, Col {1}', line, column)
				: undefined;
		if (count > 1) {
			cursorText = localize('status.editor.selections', '{0} selections', count);
		}
		if (cursorText && selected > 0) {
			cursorText = localize('status.editor.selected', '{0} ({1} selected)', cursorText, selected);
		}
		this.setEntry(
			this.cursor,
			cursorText
				? {
						text: cursorText,
						ariaLabel: cursorText,
						tooltip: localize('status.editor.gotoLine', 'Go to Line/Column'),
						run: () => {
							editor?.focus();
							return this.commands.executeCommand('workbench.action.gotoLine');
						},
					}
				: undefined,
			'ash.status.editor.cursor',
			40,
		);
		const options = model?.getOptions();
		const indentation = options
			? options.insertSpaces
				? localize('status.editor.spaces', 'Spaces: {0}', options.indentSize)
				: localize('status.editor.tabs', 'Tab Size: {0}', options.tabSize)
			: undefined;
		this.setEntry(
			this.indentation,
			indentation
				? {
						text: indentation,
						ariaLabel: indentation,
						tooltip: localize('status.editor.selectIndentation', 'Select Indentation'),
						run: () => this.showIndentationPicker(),
					}
				: undefined,
			'ash.status.editor.indentation',
			50,
		);
		const encodingSupport =
			model && this.models.getModel(model.uri) === model ? this.models.getEncodingSupport(model.uri) : undefined;
		const fileEncoding = encodingSupport?.getEncoding();
		const encoding = fileEncoding
			? getEncodingLabel(fileEncoding)
			: model
				? model.getValueLength(undefined, true) > model.getValueLength()
					? localize('status.editor.utf8Bom', 'UTF-8 with BOM')
					: 'UTF-8'
				: status?.encoding;
		this.setEntry(
			this.encoding,
			encoding
				? {
						text: encoding,
						ariaLabel: localize('status.editor.encoding', 'Editor encoding {0}', encoding),
						...(encodingSupport && editor
							? {
									tooltip: localize('status.editor.changeEncoding', 'Change File Encoding'),
									run: () => {
										editor.focus();
										return this.commands.executeCommand(ChangeEncodingAction.ID);
									},
								}
							: {}),
					}
				: undefined,
			'ash.status.editor.encoding',
			60,
		);
		const endOfLine = model ? (model.getEOL() === '\r\n' ? 'CRLF' : 'LF') : status?.endOfLine;
		this.setEntry(
			this.eol,
			endOfLine
				? {
						text: endOfLine,
						ariaLabel: localize('status.editor.eol', 'Editor end of line {0}', endOfLine),
						tooltip: localize('status.editor.selectEOL', 'Select End of Line Sequence'),
						...(editor && !editor.getOption(EditorOption.readOnly)
							? {
									run: () => {
										editor.focus();
										return this.commands.executeCommand('workbench.action.editor.changeEOL');
									},
								}
							: {}),
					}
				: undefined,
			'ash.status.editor.eol',
			70,
		);
		const languageId = model?.getLanguageId() ?? status?.languageId ?? input?.languageId;
		const language = languageId ? (this.languages.getLanguageName(languageId) ?? languageId) : undefined;
		this.setEntry(
			this.language,
			language
				? {
						text: language,
						ariaLabel: localize('status.editor.language', 'Language {0}', language),
						tooltip: localize('status.editor.selectLanguage', 'Select Language Mode'),
						...(editor
							? {
									run: () => {
										editor.focus();
										return this.commands.executeCommand(ChangeLanguageAction.ID);
									},
								}
							: {}),
					}
				: undefined,
			'ash.status.editor.language',
			80,
		);
		const workingCopy = pane?.workingCopy;
		const stateText = workingCopy?.hasExternalChange
			? localize('status.editor.conflict', 'Conflict')
			: workingCopy && (editor ? editor.getOption(EditorOption.readOnly) : input?.readOnly)
				? localize('status.editor.readOnly', 'Read-only')
				: undefined;
		this.setEntry(
			this.state,
			stateText
				? {
						text: stateText,
						ariaLabel: stateText,
						...(workingCopy?.hasExternalChange
							? {
									tooltip: localize(
										'status.editor.conflictTooltip',
										'The file changed on disk while this editor has unsaved changes.',
									),
								}
							: {}),
					}
				: undefined,
			'ash.status.editor.state',
			90,
		);
	}

	private async showIndentationPicker(): Promise<void> {
		const editor = this.activeControl;
		const model = editor?.getModel();
		if (!editor || !model) {
			return;
		}
		const items = [
			{
				label: localize('status.editor.indentSpaces', 'Indent Using Spaces'),
				id: 'editor.action.indentUsingSpaces',
			},
			{ label: localize('status.editor.indentTabs', 'Indent Using Tabs'), id: 'editor.action.indentUsingTabs' },
			{
				label: localize('status.editor.tabDisplay', 'Change Tab Display Size'),
				id: 'editor.action.changeTabDisplaySize',
			},
			{
				label: localize('status.editor.detectIndentation', 'Detect Indentation from Content'),
				id: 'editor.action.detectIndentation',
			},
			...(!editor.getOption(EditorOption.readOnly)
				? [
						{
							label: localize('status.editor.convertSpaces', 'Convert Indentation to Spaces'),
							id: 'editor.action.indentationToSpaces',
						},
						{
							label: localize('status.editor.convertTabs', 'Convert Indentation to Tabs'),
							id: 'editor.action.indentationToTabs',
						},
					]
				: []),
		];
		const item = await pickStatusItem(
			this.quickInput,
			items,
			localize('status.editor.selectIndentation', 'Select Indentation'),
			this.pickerResources,
		);
		if (!item || this.isDisposed || this.activeControl !== editor || editor.getModel() !== model) {
			return;
		}
		let size: number | undefined;
		if (items.indexOf(item) < 3) {
			const choice = await pickStatusItem(
				this.quickInput,
				Array.from({ length: 8 }, (_, index) => ({ label: String(index + 1), size: index + 1 })),
				localize('status.editor.selectTabSize', 'Select Tab Size'),
				this.pickerResources,
			);
			if (!choice || this.isDisposed || this.activeControl !== editor || editor.getModel() !== model) {
				return;
			}
			size = choice.size;
		}
		editor.focus();
		await this.commands.executeCommand(item.id, size);
	}

	private setEntry(
		slot: MutableDisposable<IStatusbarEntryAccessor>,
		entry: IStatusbarEntry | undefined,
		id: string,
		priority: number,
	): void {
		if (!entry) {
			slot.clear();
			return;
		}
		if (slot.value) slot.value.update(entry);
		else slot.value = this.statusbar.addEntry(entry, { id, alignment: StatusbarAlignment.Right, priority });
	}
}

function pickStatusItem<T extends IQuickPickItem>(
	quickInput: IQuickInputService,
	items: readonly T[],
	label: string,
	owner?: DisposableStore,
): Promise<T | undefined> {
	return new Promise(resolve => {
		const resources = new DisposableStore();
		owner?.add(resources);
		resources.add(
			toDisposable(() => {
				resolve(undefined);
				owner?.delete(resources);
			}),
		);
		const picker = resources.add(quickInput.createQuickPick<T>());
		picker.items = items;
		picker.sortByLabel = false;
		picker.placeholder = label;
		picker.ariaLabel = label;
		resources.add(
			picker.onDidAccept(() => {
				const item = picker.selectedItems[0];
				if (!item) return;
				resolve(item);
				picker.hide();
			}),
		);
		resources.add(
			picker.onDidHide(() => {
				resolve(undefined);
				resources.dispose();
			}),
		);
		picker.show();
	});
}

export class ChangeLanguageAction extends Action2 {
	public static readonly ID = 'workbench.action.editor.changeLanguageMode';
	constructor() {
		super({
			id: ChangeLanguageAction.ID,
			title: localize2('status.editor.changeLanguage', 'Change Language Mode'),
			f1: true,
		});
	}
	public override async run(accessor: ServicesAccessor, language?: unknown): Promise<void> {
		const editors = accessor.get(ICodeEditorService);
		const editor = editors.getFocusedCodeEditor() ?? editors.getActiveCodeEditor();
		const model = editor?.getModel();
		if (!editor || !model) {
			return;
		}
		const languages = accessor.get(ILanguageService);
		let languageId: string | undefined;
		if (language !== undefined) {
			if (typeof language !== 'string') {
				throw new TypeError('Language mode must be a string');
			}
			languageId = languages.isRegisteredLanguageId(language)
				? language
				: (languages.getLanguageIdByLanguageName(language) ?? undefined);
			if (!languageId) {
				throw new RangeError(`Unknown language mode: ${language}`);
			}
		} else {
			const item = await pickStatusItem(
				accessor.get(IQuickInputService),
				languages
					.getSortedRegisteredLanguageNames()
					.map(item => ({ label: item.languageName, languageId: item.languageId })),
				localize('status.editor.selectLanguage', 'Select Language Mode'),
			);
			languageId = item?.languageId;
		}
		if (
			languageId &&
			!model.isDisposed() &&
			editor.getModel() === model &&
			(editors.getFocusedCodeEditor() ?? editors.getActiveCodeEditor()) === editor
		) {
			model.setLanguage(languageId);
			editor.focus();
		}
	}
}

export class ChangeEOLAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.editor.changeEOL',
			title: localize2('status.editor.changeEOL', 'Change End of Line Sequence'),
			f1: true,
		});
	}
	public override async run(accessor: ServicesAccessor): Promise<void> {
		const editors = accessor.get(ICodeEditorService);
		const editor = editors.getFocusedCodeEditor() ?? editors.getActiveCodeEditor();
		const model: ITextModel | null | undefined = editor?.getModel();
		if (!editor || !model || editor.getOption(EditorOption.readOnly)) {
			return;
		}
		const item = await pickStatusItem(
			accessor.get(IQuickInputService),
			[
				{ label: 'LF', eol: EndOfLineSequence.LF },
				{ label: 'CRLF', eol: EndOfLineSequence.CRLF },
			],
			localize('status.editor.selectEOL', 'Select End of Line Sequence'),
		);
		if (
			!item ||
			model.isDisposed() ||
			editor.getModel() !== model ||
			editor.getOption(EditorOption.readOnly) ||
			(editors.getFocusedCodeEditor() ?? editors.getActiveCodeEditor()) !== editor
		) {
			return;
		}
		model.pushStackElement();
		model.pushEOL(item.eol);
		model.pushStackElement();
		editor.focus();
	}
}

export class ChangeEncodingAction extends Action2 {
	public static readonly ID = 'workbench.action.editor.changeEncoding';
	constructor() {
		super({
			id: ChangeEncodingAction.ID,
			title: localize2('status.editor.changeEncoding', 'Change File Encoding'),
			f1: true,
		});
	}
	public override async run(accessor: ServicesAccessor): Promise<void> {
		const editors = accessor.get(ICodeEditorService);
		const editor = editors.getFocusedCodeEditor() ?? editors.getActiveCodeEditor();
		const model = editor?.getModel();
		const models = accessor.get(IFileTextModelService);
		if (!editor || !model || models.getModel(model.uri) !== model) return;
		const support = models.getEncodingSupport(model.uri);
		if (!support) return;
		using pickerLifetime = new DisposableStore();
		pickerLifetime.add(model.onWillDispose(() => pickerLifetime.dispose()));
		const quickInput = accessor.get(IQuickInputService);
		const copies = accessor.get(IWorkingCopyService);
		const dialogs = accessor.get(IDialogService);
		const notifications = accessor.get(INotificationService);
		const isCurrent = () =>
			!model.isDisposed() &&
			editor.getModel() === model &&
			models.getModel(model.uri) === model &&
			(editors.getFocusedCodeEditor() ?? editors.getActiveCodeEditor()) === editor;
		const modes = [
			...(model.uri.scheme !== Schemas.untitled
				? [
						{
							label: localize('status.editor.reopenEncoding', 'Reopen with Encoding'),
							mode: EncodingMode.Decode,
						},
					]
				: []),
			...(!editor.getOption(EditorOption.readOnly)
				? [{ label: localize('status.editor.saveEncoding', 'Save with Encoding'), mode: EncodingMode.Encode }]
				: []),
		];
		if (modes.length === 0) return;
		const choice = await pickStatusItem(
			quickInput,
			modes,
			localize('status.editor.selectEncodingAction', 'Select an Encoding Action'),
			pickerLifetime,
		);
		if (!choice || !isCurrent()) return;
		const picks: (IQuickPickItem & { id: string })[] = [];
		if (choice.mode === EncodingMode.Decode) {
			const controller = new AbortController();
			pickerLifetime.add(toDisposable(() => controller.abort()));
			try {
				const content = await accessor
					.get(ITextFileService)
					.resolve(
						{ resource: model.uri, languageId: model.getLanguageId(), autoGuessEncoding: true },
						controller.signal,
					);
				if (!isCurrent()) return;
				picks.push({
					id: content.encoding,
					label: getEncodingLabel(content.encoding),
					description: localize('status.editor.guessedEncoding', 'Guessed from Content'),
				});
			} catch {
				if (!isCurrent()) return;
			}
		}
		for (const [id, info] of Object.entries(SUPPORTED_ENCODINGS)) {
			if (
				info.hidden ||
				(choice.mode === EncodingMode.Decode && info.encodeOnly) ||
				picks.some(pick => pick.id === id)
			)
				continue;
			picks.push({
				label: getEncodingLabel(id),
				id,
				description: id,
				detail:
					id === support.getEncoding()
						? localize('status.editor.currentEncoding', 'Current Encoding')
						: undefined,
			});
		}
		const encoding = await pickStatusItem(
			quickInput,
			picks,
			localize('status.editor.selectEncoding', 'Select File Encoding'),
			pickerLifetime,
		);
		if (
			!encoding ||
			!isCurrent() ||
			(choice.mode === EncodingMode.Encode && editor.getOption(EditorOption.readOnly))
		)
			return;
		try {
			if (choice.mode === EncodingMode.Decode) {
				const copy = copies.get(model.uri).find(copy => copy.isDirty);
				if (copy) {
					const version = model.getVersionId();
					const previousEncoding = support.getEncoding();
					const result = await dialogs.confirm({
						message: localize('status.editor.reopenDirty', 'Reopen this file with another encoding?'),
						detail: localize('status.editor.reopenDirtyDetail', 'Your unsaved changes will be discarded.'),
						primaryButton: localize('status.editor.reopenConfirm', 'Reopen'),
					});
					if (
						!result.confirmed ||
						!isCurrent() ||
						model.getVersionId() !== version ||
						support.getEncoding() !== previousEncoding
					)
						return;
					await copy.revert(new AbortController().signal);
					if (!isCurrent()) return;
				}
			}
			await support.setEncoding(encoding.id, choice.mode);
			if (isCurrent()) editor.focus();
		} catch (error) {
			if (isCurrent()) notifications.error(error instanceof Error ? error.message : String(error));
		}
	}
}
