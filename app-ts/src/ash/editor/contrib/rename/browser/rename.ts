import './renameWidget.css';
import { EditorAction, EditorCommand, registerEditorAction, registerEditorCommand, registerEditorContribution, type ServicesAccessor, type EditorCommandExecutor } from '../../../browser/editorExtensions.js';
import { addDisposableListener, getActiveElement, isNode, stopEvent, h } from '../../../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { type View } from '../../../browser/view.js';
import * as languages from '../../../common/languages.js';
import { ILanguageFeaturesService } from '../../../common/services/languageFeatures.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import { Range } from '../../../common/core/range.js';
import { type ICodeEditor } from '../../../browser/editorBrowser.js';

import { ContextKeyExpr, RawContextKey, type IContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { localize2 } from '../../../../nls.js';
import { EditorContextKeys } from '../../../common/editorContextKeys.js';

const renameInputVisible = new RawContextKey<boolean>('renameInputVisible', false);
const RenameCommandId = 'editor.action.rename';

/** Owns the local rename input and applies provider edits through the editor edit contract. */
class RenameController extends Disposable {
	static readonly ID = 'editor.contrib.renameController';
	static get(editor: ICodeEditor): RenameController | null {
		return editor.getContribution<RenameController>(RenameController.ID);
	}
	private readonly visible: IContextKey<boolean>;
	private readonly element: HTMLDivElement;
	private readonly input: HTMLInputElement;
	private readonly status: HTMLSpanElement;
	private request: AbortController | undefined;
	private context: languages.LanguageRenameRequest | undefined;
	private provider: languages.LanguageRenameProvider | undefined;
	private committing = false;

	constructor(
		private readonly editorInput: HTMLElement,
		private readonly editor: ICodeEditor,
		private readonly viewport: View,
		private readonly applyWorkspaceEdit: ((edit: languages.LanguageWorkspaceEdit) => void | Promise<void>) | undefined,
		private readonly onError: (error: unknown) => void,
		private readonly executeCommand: EditorCommandExecutor,
		@ILanguageFeaturesService private readonly languageFeaturesService: ILanguageFeaturesService,
		@IContextKeyService contextKeys: IContextKeyService,
	) {
		super();
		this.visible = renameInputVisible.bindTo(contextKeys);
		if (viewport.textModel !== editor.getModel()) {
			throw new TypeError('Rename dependencies must share one text model');
		}
		const ownerDocument = viewport.domNode.domNode.ownerDocument;
		this.element = h(ownerDocument, 'div');
		this.element.className = 'stanza-editor-rename';
		this.element.hidden = true;
		this.visible.set(false);
		this.input = h(ownerDocument, 'input');
		this.input.className = 'stanza-editor-rename-input';
		this.input.type = 'text';
		this.input.setAttribute('aria-label', 'New symbol name');
		this.status = h(ownerDocument, 'span');
		this.status.className = 'stanza-editor-rename-status';
		this.status.setAttribute('aria-live', 'polite');
		this.element.append(this.input, this.status);
		viewport.domNode.domNode.append(this.element);
		this._register(toDisposable(() => {
			this.cancel();
			this.element.remove();
		}));
		this._register(addDisposableListener(this.element, 'pointerdown', event => event.stopPropagation()));
		this._register(addDisposableListener(this.element, 'mousedown', event => event.stopPropagation()));
		// Cancel before a provider can settle ahead of the editor's deferred blur event.
		this._register(addDisposableListener(viewport.domNode.domNode, 'focusout', event => {
			if (this.request && (!isNode(event.relatedTarget) || !viewport.domNode.domNode.contains(event.relatedTarget))) {
				this.cancel();
			}
		}));
		this._register(addDisposableListener(this.input, 'input', () => {
			this.input.removeAttribute('aria-invalid');
			this.status.textContent = 'Enter to rename, Escape to cancel';
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
		this._register(addDisposableListener(this.element, 'keydown', event => this.handleWidgetKeydown(event)));
		this._register(viewport.textModel.onDidChangeContent(() => this.cancel()));
		this._register(viewport.textModel.onDidChangeLanguage(() => this.cancel()));
		this._register(viewport.textModel.onWillDispose(() => this.dispose()));
		this._register(editor.onDidChangeCursorSelection(() => this.cancel()));
		this._register(editor.onDidBlurEditorWidget(() => this.cancel()));
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
				this.status.textContent = 'Enter to rename, Escape to cancel';
				this.input.value = preparation.placeholder;
				const coordinates = this.viewport.getPositionContentCoordinates(Range.getStartPosition(preparation.range));
				this.element.style.left = `${Math.max(8, coordinates.left - this.viewport.viewportLayout.scrollPosition.left)}px`;
				this.element.style.top = `${Math.max(8, coordinates.top - this.viewport.viewportLayout.scrollPosition.top + coordinates.height + 4)}px`;
				this.element.hidden = false;
				this.visible.set(true);
				this.input.focus({ preventScroll: true });
				this.input.select();
				return;
			} catch (error) {
				if (languages.isLanguageFeatureRequestCurrent(context)) this.onError(error);
			}
		}
		if (languages.isLanguageFeatureRequestCurrent(context)) {
			this.viewport.announceAccessibilityStatus('Rename is not available at this position.');
			this.cancel();
		}
	}

	private handleWidgetKeydown(event: KeyboardEvent): void {
		if (event.defaultPrevented || event.isComposing) return;
		if (event.key === 'Escape') {
			stopEvent(event);
			this.editor.trigger('keyboard', 'cancelRenameInput', {});
			return;
		}
		if (event.key !== 'Enter' || event.ctrlKey || event.metaKey || event.altKey) return;
		stopEvent(event);
		this.editor.trigger('keyboard', 'acceptRenameInput', {});
	}

	public async accept(): Promise<void> {
		const context = this.context;
		const provider = this.provider;
		if (this.committing || !context || !provider || !languages.isLanguageFeatureRequestCurrent(context)) return;
		const newName = this.input.value.trim();
		if (newName.length === 0) {
			this.input.setAttribute('aria-invalid', 'true');
			this.status.textContent = 'Name cannot be empty';
			return;
		}
		this.committing = true;
		this.input.readOnly = true;
		this.element.setAttribute('aria-busy', 'true');
		let editDispatched = false;
		try {
			const result = await provider.provideRenameEdits(Object.freeze({ ...context, newName }), context.signal);
			if (!languages.isLanguageFeatureRequestCurrent(context)) return;
			const edit = languages.normalizeLanguageWorkspaceEdit(result);
			await this.executeCommand(RenameCommandId, async () => {
				if (!languages.isLanguageFeatureRequestCurrent(context)) return;
				if (this.applyWorkspaceEdit) {
					editDispatched = true;
					await this.applyWorkspaceEdit(edit);
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
		} finally {
			if (this.context === context) {
				this.committing = false;
				this.input.readOnly = false;
				this.element.removeAttribute('aria-busy');
			}
		}
	}

	public cancel(): void {
		const restoreFocus = this.element.contains(getActiveElement(this.element.ownerDocument));
		this.request?.abort();
		this.request = undefined;
		this.context = undefined;
		this.provider = undefined;
		this.committing = false;
		this.element.hidden = true;
		this.visible.set(false);
		this.element.removeAttribute('aria-busy');
		this.input.readOnly = false;
		this.input.removeAttribute('aria-invalid');
		this.input.value = '';
		this.status.textContent = '';
		if (!this.isDisposed && restoreFocus) this.editorInput.focus({ preventScroll: true });
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
