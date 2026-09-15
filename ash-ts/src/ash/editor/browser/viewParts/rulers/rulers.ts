import './rulers.css';
import { h } from '../../../../base/browser/dom.js';
import { FastDomNode } from '../../../../base/browser/fastDomNode.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import { EditorOption, type IRulerOption } from '../../../common/config/editorOptions.js';
import { type ViewContext } from '../../../common/viewModel/viewContext.js';
import * as viewEvents from '../../../common/viewEvents.js';
import { type RenderingContext, type RestrictedRenderingContext } from '../../view/renderingContext.js';
import { ViewPart } from '../../view/viewPart.js';

interface RulersOptions {
	readonly host: HTMLElement;
	readonly readTextLeft: () => number;
}

/** Renders configured editor rulers into the scrollable DOM content. */
export class Rulers extends ViewPart {
	public readonly domNode: FastDomNode<HTMLElement>;
	private readonly renderedRulers: FastDomNode<HTMLElement>[] = [];
	private rulers: readonly IRulerOption[];
	private typicalHalfwidthCharacterWidth: number;

	constructor(context: ViewContext, private readonly options: RulersOptions) {
		super(context);
		const element = h(options.host.ownerDocument, 'div');
		this._register(toDisposable(() => element.remove()));
		this.domNode = new FastDomNode(element);
		this.domNode.setClassName('stanza-editor-rulers');
		this.domNode.setAttribute('role', 'presentation');
		this.domNode.setAttribute('aria-hidden', 'true');
		({ rulers: this.rulers, typicalHalfwidthCharacterWidth: this.typicalHalfwidthCharacterWidth } = this.readConfiguration());
	}

	public override onConfigurationChanged(event: viewEvents.ViewConfigurationChangedEvent): boolean {
		if (!event.hasChanged(EditorOption.rulers) && !event.hasChanged(EditorOption.fontInfo)) return false;
		({ rulers: this.rulers, typicalHalfwidthCharacterWidth: this.typicalHalfwidthCharacterWidth } = this.readConfiguration());
		return true;
	}

	public override onScrollChanged(event: viewEvents.ViewScrollChangedEvent): boolean {
		return event.scrollHeightChanged || event.scrollWidthChanged;
	}

	public override prepareRender(_context: RenderingContext): void {
	}

	public render(context: RestrictedRenderingContext): void {
		this.ensureRulersCount();
		const height = Math.min(context.scrollHeight, 1_000_000);
		this.domNode.setWidth(context.scrollWidth);
		this.domNode.setHeight(height);
		for (let index = 0; index < this.rulers.length; index += 1) {
			const ruler = this.rulers[index]!;
			const node = this.renderedRulers[index]!;
			node.setLeft(this.options.readTextLeft() + ruler.column * this.typicalHalfwidthCharacterWidth);
			node.setHeight(height);
			if (ruler.color) node.domNode.style.setProperty('--stanza-editor-ruler-color', ruler.color);
			else node.domNode.style.removeProperty('--stanza-editor-ruler-color');
		}
	}

	private readConfiguration(): { readonly rulers: readonly IRulerOption[]; readonly typicalHalfwidthCharacterWidth: number } {
		const editorOptions = this._context.configuration.options;
		return {
			rulers: editorOptions.get(EditorOption.rulers),
			typicalHalfwidthCharacterWidth: editorOptions.get(EditorOption.fontInfo).typicalHalfwidthCharacterWidth,
		};
	}

	private ensureRulersCount(): void {
		while (this.renderedRulers.length < this.rulers.length) {
			const node = new FastDomNode(h(this.domNode.domNode.ownerDocument, 'div'));
			node.setClassName('stanza-editor-ruler');
			this.domNode.appendChild(node);
			this.renderedRulers.push(node);
		}
		while (this.renderedRulers.length > this.rulers.length) {
			const node = this.renderedRulers.pop()!;
			this.domNode.removeChild(node);
		}
	}
}
