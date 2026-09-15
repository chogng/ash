import { h } from '../../../../base/browser/dom.js';
import './blockDecorations.css';
import { createFastDomNode, FastDomNode } from '../../../../base/browser/fastDomNode.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import * as viewEvents from '../../../common/viewEvents.js';
import { type RenderingContext, type RestrictedRenderingContext } from '../../view/renderingContext.js';
import { ViewPart } from '../../view/viewPart.js';
import { type ViewContext } from '../../../common/viewModel/viewContext.js';
export class BlockDecorations extends ViewPart {
	public domNode: FastDomNode<HTMLElement>;
	private readonly blocks: FastDomNode<HTMLElement>[] = [];
	private contentWidth = -1;
	private contentLeft = 0;

	constructor(context: ViewContext) {
		super(context);
		this.domNode = createFastDomNode(h(document, 'div'));
		this.domNode.setClassName('stanza-editor-block-decorations blockDecorations-container');
		this.domNode.setAttribute('role', 'presentation');
		this.domNode.setAttribute('aria-hidden', 'true');
		this.update();
	}

	private update(): boolean {
		const layoutInfo = this._context.configuration.options.get(EditorOption.layoutInfo);
		const contentWidth = layoutInfo.contentWidth - layoutInfo.verticalScrollbarWidth;
		const contentLeft = layoutInfo.contentLeft;
		const changed = this.contentWidth !== contentWidth || this.contentLeft !== contentLeft;
		this.contentWidth = contentWidth;
		this.contentLeft = contentLeft;
		return changed;
	}

	public override onConfigurationChanged(_event: viewEvents.ViewConfigurationChangedEvent): boolean {
		return this.update();
	}

	public override onScrollChanged(event: viewEvents.ViewScrollChangedEvent): boolean {
		return event.scrollTopChanged || event.scrollLeftChanged;
	}

	public override onDecorationsChanged(_event: viewEvents.ViewDecorationsChangedEvent): boolean {
		return true;
	}

	public override onZonesChanged(_event: viewEvents.ViewZonesChangedEvent): boolean {
		return true;
	}

	public override prepareRender(_context: RenderingContext): void {}

	public render(context: RestrictedRenderingContext): void {
		let count = 0;
		for (const decoration of context.getDecorationsInViewport()) {
			if (!decoration.options.blockClassName) continue;
			let block = this.blocks[count];
			if (!block) {
				block = createFastDomNode(h(document, 'div'));
				this.domNode.appendChild(block);
				this.blocks.push(block);
			}
			let top: number;
			let bottom: number;
			if (decoration.options.blockIsAfterEnd) {
				top = context.getVerticalOffsetAfterLineNumber(decoration.range.endLineNumber, false);
				bottom = context.getVerticalOffsetAfterLineNumber(decoration.range.endLineNumber, true);
			} else {
				top = context.getVerticalOffsetForLineNumber(decoration.range.startLineNumber, true);
				bottom = decoration.range.isEmpty() && !decoration.options.blockDoesNotCollapse
					? context.getVerticalOffsetForLineNumber(decoration.range.startLineNumber, false)
					: context.getVerticalOffsetAfterLineNumber(decoration.range.endLineNumber, true);
			}
			const [paddingTop, paddingRight, paddingBottom, paddingLeft] = decoration.options.blockPadding ?? [0, 0, 0, 0];
			block.setClassName(`stanza-editor-block-decoration blockDecorations-block ${decoration.options.blockClassName}`);
			block.setLeft(this.contentLeft - paddingLeft);
			block.setWidth(this.contentWidth + paddingLeft + paddingRight);
			block.setTop(top - context.scrollTop - paddingTop);
			block.setHeight(bottom - top + paddingTop + paddingBottom);
			count += 1;
		}
		for (let index = count; index < this.blocks.length; index++) {
			this.blocks[index]!.domNode.remove();
		}
		this.blocks.length = count;
	}
}
