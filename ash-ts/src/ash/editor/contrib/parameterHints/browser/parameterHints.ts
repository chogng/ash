import './parameterHints.css';
import { registerEditorContribution } from '../../../browser/editorExtensions.js';
import { addDisposableListener, getActiveElement, h, isNode, stopEvent } from '../../../../base/browser/dom.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import type { View } from '../../../browser/view.js';
import type { ICodeEditor } from '../../../browser/editorBrowser.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import { TextModelChangeReason } from '../../../common/core/textChange.js';
import * as languages from '../../../common/languages.js';
import { ILanguageFeaturesService } from '../../../common/services/languageFeatures.js';

/** Owns the signature-help request, queued trigger and editor-local hint nodes. */
class ParameterHintsController extends Disposable {
	private readonly element: HTMLDivElement;
	private readonly scheduler: RunOnceScheduler;
	private pending: languages.LanguageParameterHintsContext | undefined;
	private request: AbortController | undefined;

	constructor(
		private readonly input: HTMLElement,
		private readonly editor: ICodeEditor,
		private readonly viewport: View,
		private readonly onError: (error: unknown) => void,
		@ILanguageFeaturesService private readonly languageFeaturesService: ILanguageFeaturesService,
	) {
		super();
		if (viewport.textModel !== editor.getModel()) {
			throw new TypeError('Parameter hints dependencies must share one text model');
		}
		this.element = h(viewport.domNode.domNode.ownerDocument, 'div');
		this.element.className = 'stanza-editor-parameter-hints';
		this.element.hidden = true;
		this.element.setAttribute('role', 'dialog');
		this.element.setAttribute('aria-label', 'Parameter hints');
		this.element.setAttribute('aria-live', 'polite');
		this.element.setAttribute('aria-atomic', 'true');
		viewport.domNode.domNode.append(this.element);
		this.scheduler = this._register(new RunOnceScheduler(() => {
			const context = this.pending;
			if (context) {
				void this.refresh(context);
			}
		}, 0));
		this._register(toDisposable(() => {
			this.hide();
			this.element.remove();
		}));
		this._register(addDisposableListener(input, 'keydown', event => {
			if (event.defaultPrevented || event.isComposing) {
				return;
			}
			if (event.key === 'Escape' && (this.request || this.pending || !this.element.hidden)) {
				stopEvent(event);
				this.hide();
				return;
			}
			if (event.shiftKey && !event.altKey && (event.ctrlKey || event.metaKey) && event.key === ' ') {
				stopEvent(event);
				void this.refresh({ kind: 'invoke' });
			}
		}));
		this._register(addDisposableListener(viewport.domNode.domNode, 'focusout', event => {
			if (!isNode(event.relatedTarget) || !viewport.domNode.domNode.contains(event.relatedTarget)) {
				this.hide();
			}
		}));
		this._register(editor.onDidBlurEditorWidget(() => this.hide()));
		this._register(viewport.textModel.onDidChangeContent(change => {
			const active = !!this.request || !!this.pending || !this.element.hidden;
			const pending = this.pending;
			this.hide();
			if (change.reason !== TextModelChangeReason.Edit || !this.canRequest()) {
				return;
			}
			const inserted = change.changes.length === 1 ? change.changes[0]!.text : '';
			const triggerIndex = Math.max(inserted.lastIndexOf('('), inserted.lastIndexOf(','));
			if (triggerIndex >= 0) {
				this.pending = { kind: 'triggerCharacter', triggerCharacter: inserted[triggerIndex]! };
			} else if (active) {
				this.pending = pending ?? { kind: 'contentChange' };
			}
			if (this.pending) {
				this.scheduler.schedule();
			}
		}));
		this._register(editor.onDidChangeCursorSelection(event => {
			// Typing updates content and selection in one transaction; query its final cursor.
			if (event.modelVersionId === event.oldModelVersionId) {
				this.hide();
			}
		}));
		this._register(viewport.textModel.onDidChangeLanguage(() => this.hide()));
		this._register(viewport.textModel.onWillDispose(() => this.dispose()));
		this._register(languageFeaturesService.signatureHelpProvider.onDidChange(() => this.hide()));
		this._register(editor.onDidChangeConfiguration(event => {
			if (event.hasChanged(EditorOption.parameterHints)) {
				this.hide();
			}
		}));
		this._register(viewport.onDidChangeLayout(() => {
			if (!this.element.hidden) {
				this.position();
			}
		}));
	}

	private canRequest(): boolean {
		return !this.isDisposed && !this.viewport.textModel.isDisposed()
			&& this.editor.getOption(EditorOption.parameterHints).enabled
			&& this.input.contains(getActiveElement(this.element.ownerDocument));
	}

	private async refresh(context: languages.LanguageParameterHintsContext): Promise<void> {
		this.hide();
		const model = this.viewport.textModel;
		const position = this.editor.getSelections()?.[0]?.getPosition();
		if (!this.canRequest() || !position) {
			return;
		}
		const controller = this.request = new AbortController();
		const request: languages.LanguageParameterHintsRequest = Object.freeze({
			...languages.createLanguageFeatureRequest(model, model.getLanguageId(), controller.signal),
			resource: model.uri,
			position,
			context,
		});
		for (const provider of this.languageFeaturesService.signatureHelpProvider.ordered(model)) {
			if (!languages.isLanguageFeatureRequestCurrent(request)) {
				return;
			}
			try {
				const value = await provider.provideParameterHints(request, request.signal);
				if (!languages.isLanguageFeatureRequestCurrent(request)) {
					return;
				}
				if (value) {
					const hints = normalizeParameterHints(value);
					if (hints.signatures.length > 0) {
						this.render(hints);
						return;
					}
				}
			} catch (error) {
				if (languages.isLanguageFeatureRequestCurrent(request)) {
					this.onError(error);
				}
			}
		}
		if (languages.isLanguageFeatureRequestCurrent(request)) {
			this.hide();
		}
	}

	private render(hints: languages.LanguageParameterHints): void {
		const activeSignature = hints.activeSignature ?? 0;
		this.element.replaceChildren(...hints.signatures.map((signature, index) => {
			const node = h(this.element.ownerDocument, 'div');
			node.className = `stanza-editor-parameter-hints-signature${activeSignature === index ? ' active' : ''}`;
			const activeParameter = activeSignature === index && signature.activeParameter !== undefined ? signature.parameters[signature.activeParameter] : undefined;
			const activeStart = activeParameter ? signature.label.indexOf(activeParameter.label) : -1;
			if (activeParameter && activeStart >= 0) {
				const parameter = h(this.element.ownerDocument, 'strong');
				parameter.className = 'stanza-editor-parameter-hints-parameter active';
				parameter.textContent = activeParameter.label;
				node.append(signature.label.slice(0, activeStart), parameter, signature.label.slice(activeStart + activeParameter.label.length));
			} else {
				node.textContent = signature.label;
			}
			if (signature.documentation) {
				node.title = signature.documentation;
			}
			return node;
		}));
		this.position();
		this.element.hidden = false;
	}

	private position(): void {
		const position = this.editor.getSelections()?.[0]?.getPosition();
		if (!position) {
			return;
		}
		const coordinates = this.viewport.getPositionContentCoordinates(position);
		const scroll = this.viewport.viewportLayout.scrollPosition;
		this.element.style.left = `${Math.max(8, coordinates.left - scroll.left)}px`;
		this.element.style.top = `${Math.max(8, coordinates.top - scroll.top + coordinates.height + 4)}px`;
	}

	private hide(): void {
		this.scheduler.cancel();
		this.pending = undefined;
		this.request?.abort();
		this.request = undefined;
		this.element.hidden = true;
		this.element.replaceChildren();
	}
}

function normalizeParameterHints(value: languages.LanguageParameterHints): languages.LanguageParameterHints {
	if (!value || typeof value !== 'object' || !Array.isArray(value.signatures)) {
		throw new TypeError('Parameter hints signatures must be an array');
	}
	validateActiveIndex(value.activeSignature, value.signatures.length);
	const signatures = value.signatures.map(signature => {
		if (!signature || typeof signature.label !== 'string' || !Array.isArray(signature.parameters)
			|| (signature.documentation !== undefined && typeof signature.documentation !== 'string')) {
			throw new TypeError('Parameter hints must contain a label, parameters and optional text documentation');
		}
		validateActiveIndex(signature.activeParameter, signature.parameters.length);
		const parameters = signature.parameters.map((parameter: languages.LanguageParameterInformation) => {
			if (!parameter || typeof parameter.label !== 'string'
				|| (parameter.documentation !== undefined && typeof parameter.documentation !== 'string')) {
				throw new TypeError('Parameter labels and documentation must be text');
			}
			return Object.freeze({ label: parameter.label, documentation: parameter.documentation });
		});
		return Object.freeze({
			label: signature.label,
			documentation: signature.documentation,
			parameters: Object.freeze(parameters),
			activeParameter: signature.activeParameter,
		});
	});
	return Object.freeze({ signatures: Object.freeze(signatures), activeSignature: value.activeSignature });
}

function validateActiveIndex(index: number | undefined, length: number): void {
	if (index !== undefined && (!Number.isInteger(index) || index < 0 || index >= Math.max(1, length))) {
		throw new TypeError('Parameter hints active index is outside the returned signatures or parameters');
	}
}

registerEditorContribution({
	id: 'editor.controller.parameterHints',
	install: context => {
		if (context.kind !== 'text') {
			return;
		}
		return context.instantiationService.createInstance(
			ParameterHintsController,
			context.controller.element,
			context.editor,
			context.view,
			context.onLanguageError,
		);
	},
});
