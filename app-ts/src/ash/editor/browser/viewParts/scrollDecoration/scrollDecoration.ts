import './scrollDecoration.css';
import { h } from '../../../../base/browser/dom.js';
import { FastDomNode } from '../../../../base/browser/fastDomNode.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import { EditorOption, RenderMinimap } from '../../../common/config/editorOptions.js';
import { type ViewContext } from '../../../common/viewModel/viewContext.js';
import * as viewEvents from '../../../common/viewEvents.js';
import { type RenderingContext, type RestrictedRenderingContext } from '../../view/renderingContext.js';
import { ViewPart } from '../../view/viewPart.js';

/** Projects scroll shadows without owning the editor's scroll state. */
export class ScrollDecorationViewPart extends ViewPart {
	private readonly root: FastDomNode<HTMLDivElement>;
	private readonly topShadow: FastDomNode<HTMLDivElement>;
	private readonly bottomShadow: FastDomNode<HTMLDivElement>;
	private width = 0;
	private useShadows = true;

	constructor(context: ViewContext, host: HTMLElement) {
		super(context);
		const ownerDocument = host.ownerDocument;
		const domNode = h(ownerDocument, 'div');
		this._register(toDisposable(() => domNode.remove()));
		this.root = new FastDomNode(domNode);
		this.topShadow = new FastDomNode(h(ownerDocument, 'div'));
		this.bottomShadow = new FastDomNode(h(ownerDocument, 'div'));
		this.root.setClassName('stanza-editor-scroll-decoration');
		domNode.setAttribute('role', 'presentation');
		domNode.setAttribute('aria-hidden', 'true');
		this.topShadow.setClassName('stanza-editor-scroll-decoration-shadow top');
		this.bottomShadow.setClassName('stanza-editor-scroll-decoration-shadow bottom');
		domNode.append(this.topShadow.domNode, this.bottomShadow.domNode);
		this.updateConfiguration();
	}

	public getDomNode(): FastDomNode<HTMLElement> {
		return this.root;
	}

	public override onConfigurationChanged(event: viewEvents.ViewConfigurationChangedEvent): boolean {
		if (!event.hasChanged(EditorOption.layoutInfo) && !event.hasChanged(EditorOption.scrollbar)) return false;
		return this.updateConfiguration();
	}

	public override onScrollChanged(event: viewEvents.ViewScrollChangedEvent): boolean {
		return event.scrollTopChanged || event.scrollLeftChanged || event.scrollHeightChanged;
	}

	public override prepareRender(_context: RenderingContext): void {
	}

	public render(context: RestrictedRenderingContext): void {
		this.root.setWidth(this.width);
		this.root.setHeight(context.viewportHeight);
		this.root.setTransform(`translate3d(${context.scrollLeft}px, ${context.scrollTop}px, 0)`);
		this.topShadow.setClassName(this.shadowClassName('top', this.useShadows && context.scrollTop > 0));
		this.bottomShadow.setClassName(this.shadowClassName('bottom', this.useShadows && context.scrollTop < context.scrollHeight - context.viewportHeight));
	}

	private updateConfiguration(): boolean {
		const options = this._context.configuration.options;
		const layoutInfo = options.get(EditorOption.layoutInfo);
		const scrollbar = options.get(EditorOption.scrollbar);
		const width = layoutInfo.minimap.renderMinimap === RenderMinimap.None || (layoutInfo.minimap.minimapWidth > 0 && layoutInfo.minimap.minimapLeft === 0)
			? layoutInfo.width
			: layoutInfo.width - layoutInfo.verticalScrollbarWidth;
		const changed = this.width !== width || this.useShadows !== scrollbar.useShadows;
		this.width = width;
		this.useShadows = scrollbar.useShadows;
		return changed;
	}

	private shadowClassName(edge: 'top' | 'bottom', visible: boolean): string {
		return `stanza-editor-scroll-decoration-shadow ${edge}${visible ? ' visible' : ''}`;
	}
}
