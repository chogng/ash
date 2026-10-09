import { RenameWidget, CONTEXT_RENAME_INPUT_VISIBLE } from './renameWidget.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IBulkEditService, type IBulkEditOptions } from '../../../browser/services/bulkEditService.js';
import { EditSources } from '../../../common/textModelEditSource.js';
import { localize } from '../../../../nls.js';

import { EditorAction, EditorCommand, registerEditorAction, registerEditorCommand, registerEditorContribution, type ServicesAccessor, type EditorCommandExecutor } from '../../../browser/editorExtensions.js';
import { addDisposableListener, isNode, stopEvent } from '../../../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { type View } from '../../../browser/view.js';
import * as languages from '../../../common/languages.js';
import { ILanguageFeaturesService } from '../../../common/services/languageFeatures.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import { Range } from '../../../common/core/range.js';
import { type ICodeEditor } from '../../../browser/editorBrowser.js';

import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { localize2 } from '../../../../nls.js';
import { EditorContextKeys } from '../../../common/editorContextKeys.js';

const renameInputVisible = CONTEXT_RENAME_INPUT_VISIBLE;
const RenameCommandId = 'editor.action.rename';

/** Owns provider requests and applies edits; RenameWidget owns input and focus. */
class RenameController extends Disposable {
	static readonly ID = 'editor.contrib.renameController';
	static get(editor: ICodeEditor): RenameController | null {
		return editor.getContribution<RenameController>(RenameController.ID);
	}
	private request: AbortController | undefined;
	private context: languages.LanguageRenameRequest | undefined;
	private provider: languages.LanguageRenameProvider | undefined;
	private committing = false;
	private previewing = false;
	private readonly widget: RenameWidget;
	private inputResult: Promise<void> | undefined;
	private inputRange: Range | undefined;

	constructor(
		private readonly editorInput: HTMLElement,
		private readonly editor: ICodeEditor,
		private readonly viewport: View,
		private readonly applyWorkspaceEdit: ((edit: languages.LanguageWorkspaceEdit, options?: IBulkEditOptions) => void | boolean | Promise<void | boolean>) | undefined,
		private readonly onError: (error: unknown) => void,
		private readonly executeCommand: EditorCommandExecutor,
		@ILanguageFeaturesService private readonly languageFeaturesService: ILanguageFeaturesService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IBulkEditService private readonly bulkEditService: IBulkEditService,
	) {
		super();
		this.widget = this._register(instantiationService.createInstance(RenameWidget, editor, viewport));
		if (viewport.textModel !== editor.getModel()) {
			throw new TypeError('Rename dependencies must share one text model');
		}
		this._register(toDisposable(() => this.cancel()));
		// Cancel before a provider can settle ahead of the editor's deferred blur event.
		this._register(addDisposableListener(viewport.domNode.domNode, 'focusout', event => {
			if (this.request && !this.previewing && (!isNode(event.relatedTarget) || !viewport.domNode.domNode.contains(event.relatedTarget))) {
				this.cancel();
			}
		}));
		this._register(addDisposableListener(editorInput, 'keydown', event => {
			if (event.defaultPrevented || event.isComposing) return;
			if (event.key === 'Escape' && this.request) {
				stopEvent(event);
				this.cancel();
				return;
			}
			if (event.altKey || event.ctrlKey || event.metaKey || event.key !== 'F2') return;
			if (!editor.getAction(RenameCommandId)?.isSupported()) return;
			stopEvent(event);
			editor.trigger('keyboard', RenameCommandId, {});
		}));
		this._register(viewport.textModel.onDidChangeContent(() => this.cancel()));
		this._register(viewport.textModel.onDidChangeLanguage(() => this.cancel()));
		this._register(viewport.textModel.onWillDispose(() => this.dispose()));
		this._register(editor.onDidChangeCursorSelection(() => this.cancel()));
		this._register(editor.onDidBlurEditorWidget(() => { if (!this.previewing) { this.cancel(); } }));
		this._register(languageFeaturesService.renameProvider.onDidChange(() => this.cancel()));
		this._register(editor.onDidChangeConfiguration(event => {
			if (event.hasChanged(EditorOption.readOnly)) this.cancel();
		}));
	}

	public async run(): Promise<void> {
		this.cancel();
		const model = this.viewport.textModel;
		const position = this.editor.getSelections()?.[0]?.getPosition();
		if (this.isDisposed || model.isDisposed() || !position || this.editor.getOption(EditorOption.readOnly)) return;
		const request = this.request = new AbortController();
		const context = this.context = Object.freeze({
			...languages.createLanguageFeatureRequest(model, model.getLanguageId(), request.signal),
			resource: model.uri,
			position,
		});
		for (const provider of this.languageFeaturesService.renameProvider.ordered(model)) {
			if (!languages.isLanguageFeatureRequestCurrent(context)) return;
			try {
				let preparation: languages.LanguageRenamePreparation | undefined;
				if (provider.prepareRename) {
					preparation = await provider.prepareRename(context, context.signal);
				} else {
					const word = model.getWordAtPosition(position);
					if (word) {
						preparation = {
							range: new Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
							placeholder: word.word,
						};
					}
				}
				if (!languages.isLanguageFeatureRequestCurrent(context)) return;
				if (!preparation) continue;
				if (!Range.isIRange(preparation.range) || typeof preparation.placeholder !== 'string'
					|| !Range.equalsRange(model.validateRange(preparation.range), preparation.range)
					|| !Range.containsPosition(preparation.range, position) || Range.isEmpty(preparation.range)) {
					throw new TypeError('Rename preparation must describe a valid range at the requested position');
				}
				this.provider = provider;
				this.inputRange = Range.lift(preparation.range);
				this.showInput(preparation.placeholder, context);
				return;
			} catch (error) {
				if (languages.isLanguageFeatureRequestCurrent(context)) this.onError(error);
			}
		}
		if (languages.isLanguageFeatureRequestCurrent(context)) {
			this.viewport.announceAccessibilityStatus(localize('rename.notAvailable', 'Rename is not available at this position.'));
			this.cancel();
		}
	}

	private showInput(currentName: string, context: languages.LanguageRenameRequest): void {
		this.inputResult = this.widget.getInput(this.inputRange!, currentName, context.signal, this.bulkEditService.hasPreviewHandler()).then(result => {
			if (result !== undefined && this.context === context) return this.applyName(result.newName, result.wantsPreview);
		});
	}

	public async accept(wantsPreview = false): Promise<void> {
		if (wantsPreview && !this.bulkEditService.hasPreviewHandler()) {
			throw new Error(localize('rename.previewUnavailable', 'Rename preview is not available for this editor host.'));
		}
		this.widget.acceptInput(wantsPreview);
		await this.inputResult;
	}
	private async applyName(newName: string, wantsPreview: boolean): Promise<void> {
		const context = this.context;
		const provider = this.provider;
		if (this.committing || !context || !provider || !languages.isLanguageFeatureRequestCurrent(context)) return;
		this.committing = true;
		let editDispatched = false;
		try {
			const result = await provider.provideRenameEdits(Object.freeze({ ...context, newName }), context.signal);
			if (!languages.isLanguageFeatureRequestCurrent(context)) return;
			const edit = languages.normalizeLanguageWorkspaceEdit(result);
			await this.executeCommand(RenameCommandId, async () => {
				if (!languages.isLanguageFeatureRequestCurrent(context)) return;
				if (wantsPreview) {
					// Preview owns focus while this version-bound request remains active for approval.
					this.previewing = true;
					editDispatched = true;
					await this.bulkEditService.apply(edit, {
						editor: this.editor, label: localize('bulkEdit.renameLabel', 'Rename to {0}', newName),
						code: 'undoredo.rename', respectAutoSaveConfig: true, showPreview: true,
						token: context.signal, reason: EditSources.rename(undefined, newName),
					});
					return;
				}
				if (this.applyWorkspaceEdit) {
					editDispatched = true;
					await this.applyWorkspaceEdit(edit, {
						editor: this.editor,
						label: localize('bulkEdit.renameLabel', 'Rename to {0}', newName),
						code: 'undoredo.rename',
						respectAutoSaveConfig: true,
						reason: EditSources.rename(undefined, newName),
					});
					return;
				}
				if (edit.entries.length === 0) return;
				const documentEdit = edit.entries.find(candidate => candidate.kind === 'textDocument' && candidate.resource.toString() === context.resource.toString());
				if (edit.entries.length !== 1 || !documentEdit || documentEdit.kind !== 'textDocument') {
					throw new Error('This editor host cannot apply a multi-resource rename');
				}
				if (documentEdit.version !== undefined && documentEdit.version !== context.snapshot.version) {
					throw new Error('Rename edit does not match the requested document version');
				}
				if (documentEdit.expectedText !== undefined && documentEdit.expectedText !== context.model.getValue()) {
					throw new Error('Rename edit does not match the requested document text');
				}
				if (documentEdit.edits.length === 0) return;
				editDispatched = true;
				this.editor.pushUndoStop();
				this.editor.executeEdits(RenameCommandId, [...documentEdit.edits]);
				this.editor.pushUndoStop();
			});
			if (this.context === context) this.cancel();
		} catch (error) {
			if (editDispatched || languages.isLanguageFeatureRequestCurrent(context)) this.onError(error);
			if (languages.isLanguageFeatureRequestCurrent(context) && this.context === context) this.showInput(newName, context);
		} finally {
			if (this.context === context) {
				this.previewing = false;
				this.committing = false;
			}
		}
	}

	public cancel(): void {
		this.request?.abort();
		this.request = undefined;
		this.context = undefined;
		this.provider = undefined;
		this.committing = false;
		this.previewing = false;
		this.inputRange = undefined;
		this.widget.cancelInput(true, 'controller');
	}
}

registerEditorContribution({
	id: RenameController.ID,
	commands: [{ id: RenameCommandId, canTriggerInlineEdits: true }],
	install: context => {
		if (context.kind !== 'text') return;
		return context.instantiationService.createInstance(
			RenameController,
			context.controller.element,
			context.editor,
			context.view,
			context.options.onApplyWorkspaceEdit,
			context.onLanguageError,
			context.executeCommand,
		);
	},
});

class RenameAction extends EditorAction {
	constructor() {
		super({
			id: RenameCommandId,
			label: localize2('rename.label', 'Rename Symbol'),
			precondition: ContextKeyExpr.and(EditorContextKeys.writable, EditorContextKeys.hasRenameProvider.isEqualTo(true)),
			kbOpts: { kbExpr: EditorContextKeys.editorTextFocus.isEqualTo(true), primary: KeyCode.F2, weight: KeybindingWeight.EditorContrib },
			canTriggerInlineEdits: true,
			contextMenuOpts: { group: '1_modification', order: 1.1 },
		});
	}

	async run(_accessor: ServicesAccessor, editor: ICodeEditor): Promise<void> {
		editor.focus();
		await RenameController.get(editor)?.run();
	}
}
registerEditorAction(RenameAction);

const RenameInputCommand = EditorCommand.bindToContribution(RenameController.get);
registerEditorCommand(new RenameInputCommand({
	id: 'acceptRenameInputWithPreview',
	precondition: ContextKeyExpr.and(EditorContextKeys.writable, renameInputVisible.isEqualTo(true)),
	handler: controller => controller.accept(true),
}));
registerEditorCommand(new RenameInputCommand({
	id: 'acceptRenameInput',
	precondition: ContextKeyExpr.and(EditorContextKeys.writable, renameInputVisible.isEqualTo(true)),
	handler: controller => controller.accept(),
	kbOpts: { kbExpr: EditorContextKeys.focus.isEqualTo(true), primary: KeyCode.Enter, weight: KeybindingWeight.EditorContrib + 100 },
}));
registerEditorCommand(new RenameInputCommand({
	id: 'cancelRenameInput',
	precondition: undefined,
	handler: controller => controller.cancel(),
	kbOpts: { kbExpr: ContextKeyExpr.and(EditorContextKeys.focus.isEqualTo(true), renameInputVisible.isEqualTo(true)), primary: KeyCode.Escape, weight: KeybindingWeight.EditorContrib + 100 },
}));
