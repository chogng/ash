import { h } from '../../../../base/browser/dom.js';
import "./margin.css";
import { createFastDomNode, FastDomNode } from "../../../../base/browser/fastDomNode.js";
import { type RenderingContext, type RestrictedRenderingContext } from "../../view/renderingContext.js";
import { ViewPart } from "../../view/viewPart.js";
import { type ViewContext } from '../../../common/viewModel/viewContext.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import * as viewEvents from '../../../common/viewEvents.js';

export class Margin extends ViewPart {
	public static readonly CLASS_NAME = 'glyph-margin';
	public static readonly OUTER_CLASS_NAME = 'margin';
	private readonly _domNode: FastDomNode<HTMLElement>;
	private readonly _glyphMarginBackgroundDomNode: FastDomNode<HTMLElement>;
	private _canUseLayerHinting: boolean;
	private _contentLeft: number;
	private _glyphMarginLeft: number;
	private _glyphMarginWidth: number;
	private _lineNumbersLeft: number;
	private _lineNumbersWidth: number;
	private _decorationsLeft: number;
	private _decorationsWidth: number;

	constructor(context: ViewContext) {
		super(context);
		const options = this._context.configuration.options;
		const layoutInfo = options.get(EditorOption.layoutInfo);
		this._canUseLayerHinting = !options.get(EditorOption.disableLayerHinting);
		this._contentLeft = layoutInfo.contentLeft;
		this._glyphMarginLeft = layoutInfo.glyphMarginLeft;
		this._glyphMarginWidth = layoutInfo.glyphMarginWidth;
		this._lineNumbersLeft = layoutInfo.lineNumbersLeft;
		this._lineNumbersWidth = layoutInfo.lineNumbersWidth;
		this._decorationsLeft = layoutInfo.decorationsLeft;
		this._decorationsWidth = layoutInfo.decorationsWidth;
		this._domNode = createFastDomNode(h(document, 'div'));
		this._domNode.setClassName(Margin.OUTER_CLASS_NAME);
		this._domNode.setPosition('absolute');
		this._domNode.setAttribute('role', 'presentation');
		this._domNode.setAttribute('aria-hidden', 'true');
		this._glyphMarginBackgroundDomNode = createFastDomNode(h(document, 'div'));
		this._glyphMarginBackgroundDomNode.setClassName(Margin.CLASS_NAME);
		this._domNode.appendChild(this._glyphMarginBackgroundDomNode);
	}

	public getDomNode(): FastDomNode<HTMLElement> {
		return this._domNode;
	}

	public override onConfigurationChanged(_event: viewEvents.ViewConfigurationChangedEvent): boolean {
		const options = this._context.configuration.options;
		const layoutInfo = options.get(EditorOption.layoutInfo);
		this._canUseLayerHinting = !options.get(EditorOption.disableLayerHinting);
		this._contentLeft = layoutInfo.contentLeft;
		this._glyphMarginLeft = layoutInfo.glyphMarginLeft;
		this._glyphMarginWidth = layoutInfo.glyphMarginWidth;
		this._lineNumbersLeft = layoutInfo.lineNumbersLeft;
		this._lineNumbersWidth = layoutInfo.lineNumbersWidth;
		this._decorationsLeft = layoutInfo.decorationsLeft;
		this._decorationsWidth = layoutInfo.decorationsWidth;
		return true;
	}

	public override onScrollChanged(event: viewEvents.ViewScrollChangedEvent): boolean {
		return super.onScrollChanged(event) || event.scrollTopChanged || event.scrollLeftChanged;
	}

	public override prepareRender(_context: RenderingContext): void {}

	public render(context: RestrictedRenderingContext): void {
		this._domNode.setLayerHinting(this._canUseLayerHinting);
		this._domNode.setContain('strict');
		this._domNode.setLeft(context.scrollLeft);
		this._domNode.setTop(-(context.scrollTop - context.bigNumbersDelta));
		const height = Math.min(context.scrollHeight, 1_000_000);
		this._domNode.setHeight(height);
		this._domNode.setWidth(this._contentLeft);
		this._glyphMarginBackgroundDomNode.setLeft(this._glyphMarginLeft);
		this._glyphMarginBackgroundDomNode.setWidth(this._glyphMarginWidth);
		this._glyphMarginBackgroundDomNode.setHeight(height);
		for (const node of [this._domNode.domNode, this._domNode.domNode.parentElement]) {
			if (!node) continue;
			node.style.setProperty('--stanza-editor-gutter-width', `${this._contentLeft}px`);
			node.style.setProperty('--stanza-editor-line-numbers-width', `${this._lineNumbersWidth}px`);
			node.style.setProperty('--stanza-editor-glyph-margin-width', `${this._glyphMarginWidth}px`);
			node.style.setProperty('--stanza-editor-line-numbers-left', `${this._lineNumbersLeft}px`);
			node.style.setProperty('--stanza-editor-line-decorations-left', `${this._decorationsLeft}px`);
			node.style.setProperty('--stanza-editor-line-decorations-width', `${this._decorationsWidth}px`);
		}
	}
}
