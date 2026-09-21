import './renameWidget.css';
import { registerEditorContribution, type EditorCommandExecutor } from '../../../browser/editorExtensions.js';
import { addDisposableListener, getActiveElement, isNode, stopEvent, h } from '../../../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { type View } from '../../../browser/view.js';
import * as languages from '../../../common/languages.js';
import { ILanguageFeaturesService } from '../../../common/services/languageFeatures.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import { Range } from '../../../common/core/range.js';
import { type ICodeEditor } from '../../../browser/editorBrowser.js';

const RenameCommandId = 'editor.action.rename';

/** Owns the local rename input and applies provider edits through the editor edit contract. */
class RenameController extends Disposable {
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
	) {
		super();
		if (viewport.textModel !== editor.getModel()) {
			throw new TypeError('Rename dependencies must share one text model');
		}
		const ownerDocument = viewport.domNode.domNode.ownerDocument;
		this.element = h(ownerDocument, 'div');
		this.element.className = 'stanza-editor-rename';
		this.element.hidden = true;
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
			this.close();
			this.element.remove();
		}));
		this._register(addDisposableListener(this.element, 'pointerdown', event => event.stopPropagation()));
		this._register(addDisposableListener(this.element, 'mousedown', event => event.stopPropagation()));
		// Cancel before a provider can settle ahead of the editor's deferred blur event.
		this._register(addDisposableListener(viewport.domNode.domNode, 'focusout', event => {
			if (this.request && (!isNode(event.relatedTarget) || !viewport.domNode.domNode.contains(event.relatedTarget))) {
				this.close();
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
				this.close();
				return;
			}
			if (event.altKey || event.ctrlKey || event.metaKey || event.key !== 'F2') return;
			stopEvent(event);
			void this.open();
		}));
		this._register(addDisposableListener(this.element, 'keydown', event => this.handleWidgetKeydown(event)));
		this._register(viewport.textModel.onDidChangeContent(() => this.close()));
		this._register(viewport.textModel.onDidChangeLanguage(() => this.close()));
		this._register(viewport.textModel.onWillDispose(() => this.dispose()));
		this._register(editor.onDidChangeCursorSelection(() => this.close()));
		this._register(editor.onDidBlurEditorWidget(() => this.close()));
		this._register(languageFeaturesService.renameProvider.onDidChange(() => this.close()));
		this._register(editor.onDidChangeConfiguration(event => {
			if (event.hasChanged(EditorOption.readOnly)) this.close();
		}));
	}

	private async open(): Promise<void> {
		this.close();
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
				this.input.focus({ preventScroll: true });
				this.input.select();
				return;
			} catch (error) {
				if (languages.isLanguageFeatureRequestCurrent(context)) this.onError(error);
			}
		}
		if (languages.isLanguageFeatureRequestCurrent(context)) {
			this.viewport.announceAccessibilityStatus('Rename is not available at this position.');
			this.close();
		}
	}

	private handleWidgetKeydown(event: KeyboardEvent): void {
		if (event.defaultPrevented || event.isComposing) return;
		if (event.key === 'Escape') {
			stopEvent(event);
			this.close();
			return;
		}
		if (event.key !== 'Enter' || event.ctrlKey || event.metaKey || event.altKey) return;
		stopEvent(event);
		void this.commit();
	}

	private async commit(): Promise<void> {
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
			if (this.context === context) this.close();
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

	private close(): void {
		const restoreFocus = this.element.contains(getActiveElement(this.element.ownerDocument));
		this.request?.abort();
		this.request = undefined;
		this.context = undefined;
		this.provider = undefined;
		this.committing = false;
		this.element.hidden = true;
		this.element.removeAttribute('aria-busy');
		this.input.readOnly = false;
		this.input.removeAttribute('aria-invalid');
		this.input.value = '';
		this.status.textContent = '';
		if (!this.isDisposed && restoreFocus) this.editorInput.focus({ preventScroll: true });
	}
}

registerEditorContribution({
	id: 'editor.contrib.renameController',
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
