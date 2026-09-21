import './parameterHints.css';
import { EditorAction, EditorCommand, registerEditorAction, registerEditorCommand, registerEditorContribution, type ServicesAccessor } from '../../../browser/editorExtensions.js';
import { addDisposableListener, getActiveElement, h, isNode, stopEvent } from '../../../../base/browser/dom.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { localize, localize2 } from '../../../../nls.js';
import { ContextKeyExpr, RawContextKey, type IContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import type { View } from '../../../browser/view.js';
import type { ICodeEditor } from '../../../browser/editorBrowser.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import { EditorContextKeys } from '../../../common/editorContextKeys.js';
import { TextModelChangeReason } from '../../../common/core/textChange.js';
import * as languages from '../../../common/languages.js';
import { ILanguageFeaturesService } from '../../../common/services/languageFeatures.js';

const visible = new RawContextKey<boolean>('parameterHintsVisible', false);
const multipleSignatures = new RawContextKey<boolean>('parameterHintsMultipleSignatures', false);

/** Owns the signature-help request, queued trigger and editor-local hint nodes. */
class ParameterHintsController extends Disposable {
	public static readonly ID = 'editor.controller.parameterHints';

	public static get(editor: ICodeEditor): ParameterHintsController | null {
		return editor.getContribution<ParameterHintsController>(ParameterHintsController.ID);
	}

	private readonly element: HTMLDivElement;
	private readonly scheduler: RunOnceScheduler;
	private readonly visibleKey: IContextKey<boolean>;
	private readonly multipleSignaturesKey: IContextKey<boolean>;
	private hints: languages.LanguageParameterHints | undefined;
	private pending: languages.LanguageParameterHintsContext | undefined;
	private request: AbortController | undefined;

	constructor(
		private readonly input: HTMLElement,
		private readonly editor: ICodeEditor,
		private readonly viewport: View,
		private readonly onError: (error: unknown) => void,
		@ILanguageFeaturesService private readonly languageFeaturesService: ILanguageFeaturesService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();
		if (viewport.textModel !== editor.getModel()) {
			throw new TypeError('Parameter hints dependencies must share one text model');
		}
		this.visibleKey = visible.bindTo(contextKeyService);
		this.multipleSignaturesKey = multipleSignatures.bindTo(contextKeyService);
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
		this._register(editor.onKeyDown(keyboardEvent => {
			const event = keyboardEvent.browserEvent;
			if (event.defaultPrevented || event.isComposing) {
				return;
			}
			if (event.key === 'Escape' && (this.request || this.pending || !this.element.hidden)) {
				stopEvent(event);
				editor.trigger('keyboard', 'closeParameterHints', {});
				return;
			}
			if (event.shiftKey && !event.altKey && (event.ctrlKey || event.metaKey) && event.key === ' ') {
				if (!editor.getAction('editor.action.triggerParameterHints')?.isSupported()) {
					return;
				}
				stopEvent(event);
				editor.trigger('keyboard', 'editor.action.triggerParameterHints', {});
				return;
			}
			if (this.element.hidden || !this.hints || this.hints.signatures.length < 2 || event.shiftKey || event.metaKey) {
				return;
			}
			const macControl = isMacintosh && event.ctrlKey && !event.altKey;
			const previous = (!event.ctrlKey && event.key === 'ArrowUp') || (macControl && event.key.toLowerCase() === 'p');
			const next = (!event.ctrlKey && event.key === 'ArrowDown') || (macControl && event.key.toLowerCase() === 'n');
			if (previous || next) {
				stopEvent(event);
				editor.trigger('keyboard', previous ? 'showPrevParameterHint' : 'showNextParameterHint', {});
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

	public trigger(context: languages.LanguageParameterHintsContext): Promise<void> {
		return this.refresh(context);
	}

	public cancel(): void {
		this.hide();
	}

	public previous(): void {
		this.move(-1);
	}

	public next(): void {
		this.move(1);
	}

	private move(delta: number): void {
		if (!this.hints || this.isDisposed) {
			return;
		}
		const previous = this.hints.activeSignature ?? 0;
		const count = this.hints.signatures.length;
		const next = previous + delta;
		if ((next < 0 || next >= count) && !this.editor.getOption(EditorOption.parameterHints).cycle) {
			this.hide();
			return;
		}
		const activeSignature = (next + count) % count;
		this.hints = Object.freeze({ ...this.hints, activeSignature });
		this.renderSignature(this.element.children[previous]! as HTMLElement, this.hints.signatures[previous]!, false);
		this.renderSignature(this.element.children[activeSignature]! as HTMLElement, this.hints.signatures[activeSignature]!, true);
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
		this.hints = hints;
		const activeSignature = hints.activeSignature ?? 0;
		this.element.replaceChildren(...hints.signatures.map((signature, index) => {
			const node = h(this.element.ownerDocument, 'div');
			this.renderSignature(node, signature, activeSignature === index);
			return node;
		}));
		this.element.setAttribute('aria-description', hints.signatures.length > 1
			? localize('parameterHints.navigation', 'Use Up and Down to change the active signature. Press Escape to close.')
			: localize('parameterHints.close', 'Press Escape to close.'));
		this.position();
		this.element.hidden = false;
		this.multipleSignaturesKey.set(hints.signatures.length > 1);
		this.visibleKey.set(true);
	}

	private renderSignature(node: HTMLElement, signature: languages.LanguageSignatureInformation, active: boolean): void {
		node.className = `stanza-editor-parameter-hints-signature${active ? ' active' : ''}`;
		node.setAttribute('aria-current', String(active));
		node.title = signature.documentation ?? '';
		const parameter = active && signature.activeParameter !== undefined ? signature.parameters[signature.activeParameter] : undefined;
		const start = parameter ? signature.label.indexOf(parameter.label) : -1;
		if (parameter && start >= 0) {
			const strong = h(this.element.ownerDocument, 'strong');
			strong.className = 'stanza-editor-parameter-hints-parameter active';
			strong.textContent = parameter.label;
			node.replaceChildren(signature.label.slice(0, start), strong, signature.label.slice(start + parameter.label.length));
		} else {
			node.textContent = signature.label;
		}
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
		this.hints = undefined;
		this.element.hidden = true;
		this.element.replaceChildren();
		this.element.removeAttribute('aria-description');
		this.visibleKey.reset();
		this.multipleSignaturesKey.reset();
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

class TriggerParameterHintsAction extends EditorAction {
	constructor() {
		super({
			id: 'editor.action.triggerParameterHints',
			label: localize2('parameterHints.trigger.label', 'Trigger Parameter Hints'),
			precondition: EditorContextKeys.hasSignatureHelpProvider.isEqualTo(true),
			kbOpts: {
				kbExpr: EditorContextKeys.editorTextFocus.isEqualTo(true),
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Space,
				weight: KeybindingWeight.EditorContrib,
			},
		});
	}

	public async run(_accessor: ServicesAccessor, editor: ICodeEditor): Promise<void> {
		const controller = ParameterHintsController.get(editor);
		if (controller) {
			editor.focus();
			await controller.trigger({ kind: 'invoke' });
		}
	}
}

registerEditorAction(TriggerParameterHintsAction);

const ParameterHintsCommand = EditorCommand.bindToContribution(ParameterHintsController.get);
registerEditorCommand(new ParameterHintsCommand({
	id: 'closeParameterHints',
	precondition: undefined,
	handler: controller => controller.cancel(),
	kbOpts: {
		kbExpr: ContextKeyExpr.and(EditorContextKeys.focus.isEqualTo(true), visible.isEqualTo(true)),
		primary: KeyCode.Escape,
		secondary: [KeyMod.Shift | KeyCode.Escape],
		weight: KeybindingWeight.EditorContrib + 75,
	},
}));

registerEditorCommand(new ParameterHintsCommand({
	id: 'showPrevParameterHint',
	precondition: ContextKeyExpr.and(visible.isEqualTo(true), multipleSignatures.isEqualTo(true)),
	handler: controller => controller.previous(),
	kbOpts: {
		kbExpr: EditorContextKeys.focus.isEqualTo(true),
		primary: KeyCode.UpArrow,
		secondary: [KeyMod.Alt | KeyCode.UpArrow],
		mac: { primary: KeyCode.UpArrow, secondary: [KeyMod.Alt | KeyCode.UpArrow, KeyMod.WinCtrl | KeyCode.KeyP] },
		weight: KeybindingWeight.EditorContrib + 75,
	},
}));

registerEditorCommand(new ParameterHintsCommand({
	id: 'showNextParameterHint',
	precondition: ContextKeyExpr.and(visible.isEqualTo(true), multipleSignatures.isEqualTo(true)),
	handler: controller => controller.next(),
	kbOpts: {
		kbExpr: EditorContextKeys.focus.isEqualTo(true),
		primary: KeyCode.DownArrow,
		secondary: [KeyMod.Alt | KeyCode.DownArrow],
		mac: { primary: KeyCode.DownArrow, secondary: [KeyMod.Alt | KeyCode.DownArrow, KeyMod.WinCtrl | KeyCode.KeyN] },
		weight: KeybindingWeight.EditorContrib + 75,
	},
}));

registerEditorContribution({
	id: ParameterHintsController.ID,
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
