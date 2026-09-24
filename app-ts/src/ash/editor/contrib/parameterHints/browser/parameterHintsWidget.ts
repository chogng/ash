import './parameterHints.css';
import { h, isNode, addDisposableListener } from '../../../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { type IContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { type IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { ContentWidgetPositionPreference, type ICodeEditor, type IContentWidget, type IContentWidgetPosition } from '../../../browser/editorBrowser.js';
import { type View } from '../../../browser/view.js';
import { type LanguageParameterHints, type LanguageSignatureInformation } from '../../../common/languages.js';
import { ParameterHintsModel } from './parameterHintsModel.js';
import { Context } from './provideSignatureHelp.js';

/** Renders the current hint beside the caret and owns its editor-local DOM. */
export class ParameterHintsWidget extends Disposable implements IContentWidget {
	static readonly ID = 'editor.widget.parameterHintsWidget';
	private readonly element: HTMLDivElement;
	private readonly visibleKey: IContextKey<boolean>;
	private readonly multipleSignaturesKey: IContextKey<boolean>;
	private hints: LanguageParameterHints | undefined;

	constructor(
		viewport: View,
		private readonly editor: ICodeEditor,
		private readonly model: ParameterHintsModel,
		contextKeyService: IContextKeyService,
	) {
		super();
		this.visibleKey = Context.Visible.bindTo(contextKeyService);
		this.multipleSignaturesKey = Context.MultipleSignatures.bindTo(contextKeyService);
		this.element = h(viewport.domNode.domNode.ownerDocument, 'div');
		this.element.className = 'stanza-editor-parameter-hints';
		this.element.hidden = true;
		this.element.setAttribute('role', 'dialog');
		this.element.setAttribute('aria-label', localize('parameterHints.dialog', 'Parameter hints'));
		this.element.setAttribute('aria-live', 'polite');
		this.element.setAttribute('aria-atomic', 'true');
		editor.addContentWidget(this);
		this._register(toDisposable(() => {
			this.hide();
			editor.removeContentWidget(this);
		}));
		this._register(model.onChangedHints(hints => {
			if (hints) this.render(hints);
			else this.hide();
		}));
		this._register(addDisposableListener(viewport.domNode.domNode, 'focusout', event => {
			if (!isNode(event.relatedTarget) || !viewport.domNode.domNode.contains(event.relatedTarget)) {
				model.cancel();
			}
		}));
	}

	get isVisible(): boolean {
		return !this.element.hidden;
	}

	getId(): string {
		return ParameterHintsWidget.ID;
	}

	getDomNode(): HTMLElement {
		return this.element;
	}

	getPosition(): IContentWidgetPosition | null {
		return this.isVisible ? {
			position: this.editor.getPosition(),
			preference: [ContentWidgetPositionPreference.BELOW, ContentWidgetPositionPreference.ABOVE],
		} : null;
	}

	private render(hints: LanguageParameterHints): void {
		const previous = this.hints;
		this.hints = hints;
		const activeSignature = hints.activeSignature ?? 0;
		if (previous?.signatures === hints.signatures && this.isVisible && this.element.childElementCount === hints.signatures.length) {
			const previousIndex = previous.activeSignature ?? 0;
			if (previousIndex !== activeSignature) {
				this.renderSignature(this.element.children[previousIndex]! as HTMLElement, hints.signatures[previousIndex]!, false);
				this.renderSignature(this.element.children[activeSignature]! as HTMLElement, hints.signatures[activeSignature]!, true);
			}
			this.editor.layoutContentWidget(this);
			return;
		}
		this.element.replaceChildren(...hints.signatures.map((signature, index) => {
			const node = h(this.element.ownerDocument, 'div');
			this.renderSignature(node, signature, activeSignature === index);
			return node;
		}));
		this.element.setAttribute('aria-description', hints.signatures.length > 1
			? localize('parameterHints.navigation', 'Use Up and Down to change the active signature. Press Escape to close.')
			: localize('parameterHints.close', 'Press Escape to close.'));
		this.element.hidden = false;
		this.multipleSignaturesKey.set(hints.signatures.length > 1);
		this.visibleKey.set(true);
		this.editor.layoutContentWidget(this);
	}

	private renderSignature(node: HTMLElement, signature: LanguageSignatureInformation, active: boolean): void {
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

	private hide(): void {
		const visible = this.isVisible;
		this.hints = undefined;
		this.element.hidden = true;
		this.element.replaceChildren();
		this.element.removeAttribute('aria-description');
		this.visibleKey.reset();
		this.multipleSignaturesKey.reset();
		if (visible) this.editor.layoutContentWidget(this);
	}
}
