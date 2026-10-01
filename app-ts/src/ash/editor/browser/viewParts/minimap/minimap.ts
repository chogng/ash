import './minimap.css';
import { MinimapTokensColorTracker } from '../../../common/viewModel/minimapTokensColorTracker.js';
import { TokenizationRegistry } from '../../../common/languages.js';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { FastDomNode } from '../../../../base/browser/fastDomNode.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import { clamp } from '../../../../base/common/numbers.js';
import { isFullWidthCharacter } from '../../../../base/common/strings.js';
import { editorBackground, editorForeground } from '../../../../platform/theme/common/colors/editorColors.js';
import { RGBA8 } from '../../../common/core/misc/rgba.js';
import { MinimapCharRendererFactory } from './minimapCharRendererFactory.js';
import { Constants } from './minimapCharSheet.js';
import { type EditorMinimapLayoutInfo, EditorOption, RenderMinimap } from '../../../common/config/editorOptions.js';
import { type TextModel } from '../../../common/model/textModel.js';
import { type SemanticTokenSource } from '../../../common/tokens/languageTokens.js';
import { type EditorVisualLineProjection } from '../../../common/viewModel/modelLineProjection.js';
import { type EditorViewportLayout } from '../../../common/viewLayout/viewLayout.js';
import { type RestrictedRenderingContext } from '../../view/renderingContext.js';
import { ViewPart, PartFingerprint, PartFingerprints } from '../../view/viewPart.js';
import { type ViewContext } from '../../../common/viewModel/viewContext.js';
import { Range } from '../../../common/core/range.js';
import { type EditorScrollPosition } from '../../../common/viewModel.js';
import type * as viewEvents from '../../../common/viewEvents.js';

export interface MinimapOptions {
	readonly host: HTMLElement;
	readonly model: TextModel;
	readonly semanticTokenSource?: SemanticTokenSource;
	readonly readLayout: () => EditorViewportLayout;
	readonly readVisualProjection: () => EditorVisualLineProjection;
	readonly readProjectionRevision: () => number;
	readonly scrollTo: (position: EditorScrollPosition) => void;
}

/** Owns the document overview canvas, viewport indicator, markers, and pointer navigation. */
export class Minimap extends ViewPart {
	private readonly domNode: HTMLDivElement;
	private readonly root: FastDomNode<HTMLDivElement>;
	private readonly canvas: HTMLCanvasElement;
	private readonly slider: HTMLDivElement;
	private dragging = false;
	private dragOffset = 0;
	private contentHeight = 0;
	private sliderHeight = 0;
	private sliderTop = 0;
	private rasterKey: string | undefined;
	private rasterDirty = true;

	constructor(context: ViewContext, private readonly source: MinimapOptions) {
		super(context);
		this.domNode = h(source.host.ownerDocument, 'div');
		this.root = new FastDomNode(this.domNode);
		this.domNode.className = 'minimap';
		this.root.setPosition('absolute');
		this.domNode.setAttribute('role', 'presentation');
		this.domNode.setAttribute('aria-hidden', 'true');
		PartFingerprints.write(this.domNode, PartFingerprint.Minimap);
		this.canvas = h(source.host.ownerDocument, 'canvas');
		this.canvas.style.position = 'absolute';
		this.canvas.style.left = '0';
		this.slider = h(source.host.ownerDocument, 'div');
		this.slider.className = 'stanza-editor-minimap-slider';
		this.slider.setAttribute('aria-hidden', 'true');
		this.domNode.append(this.canvas, this.slider);
		this._register(toDisposable(() => this.domNode.remove()));
		this._register(MinimapTokensColorTracker.getInstance().onDidChange(() => this.invalidateRaster()));
		this._register(addDisposableListener(this.domNode, 'pointerdown', event => {
			if (event.button !== 0) return;
			const localY = event.clientY - this.domNode.getBoundingClientRect().top;
			this.dragOffset = localY >= this.sliderTop && localY <= this.sliderTop + this.sliderHeight
				? localY - this.sliderTop
				: this.sliderHeight / 2;
			this.dragging = true;
			this.domNode.classList.add('stanza-editor-minimap-dragging');
			this.domNode.setPointerCapture(event.pointerId);
			this.moveTo(event.clientY);
			event.preventDefault();
		}));
		this._register(addDisposableListener(this.domNode, 'pointermove', event => {
			if (this.dragging) this.moveTo(event.clientY);
		}));
		this._register(addDisposableListener(this.domNode, 'pointerup', event => {
			this.dragging = false;
			this.domNode.classList.remove('stanza-editor-minimap-dragging');
			if (this.domNode.hasPointerCapture(event.pointerId)) this.domNode.releasePointerCapture(event.pointerId);
		}));
		this._register(addDisposableListener(this.domNode, 'pointercancel', () => {
			this.dragging = false;
			this.domNode.classList.remove('stanza-editor-minimap-dragging');
		}));
	}

	public getDomNode(): FastDomNode<HTMLElement> {
		return this.root;
	}

	public override onConfigurationChanged(event: viewEvents.ViewConfigurationChangedEvent): boolean {
		if (event.hasChanged(EditorOption.minimap) || event.hasChanged(EditorOption.fontInfo) || event.hasChanged(EditorOption.lineHeight) || event.hasChanged(EditorOption.padding)) {
			this.invalidateRaster();
		}
		return true;
	}

	public override onFlushed(): boolean { return this.invalidateRaster(); }
	public override onLineMappingChanged(): boolean { return this.invalidateRaster(); }
	public override onTokensChanged(): boolean { return this.invalidateRaster(); }
	public override onTokensColorsChanged(): boolean { return this.invalidateRaster(); }
	public override onThemeChanged(): boolean { return this.invalidateRaster(); }
	public override onDecorationsChanged(event: viewEvents.ViewDecorationsChangedEvent): boolean {
		return event.affectsMinimap ? this.invalidateRaster() : false;
	}

	render(context: RestrictedRenderingContext): void {
		const geometry = this._context.configuration.options.get(EditorOption.layoutInfo).minimap;
		const minimap = this._context.configuration.options.get(EditorOption.minimap);
		const padding = this._context.configuration.options.get(EditorOption.padding);
		const visible = minimap.enabled && geometry.renderMinimap !== RenderMinimap.None && geometry.minimapWidth > 0 && context.viewportHeight > 0;
		this.domNode.style.display = visible ? '' : 'none';
		this.slider.hidden = !visible;
		if (!visible) return;

		const projection = this.source.readVisualProjection();
		const lineHeight = Math.max(1, this.source.readLayout().lineHeight);
		const rows = projection.visualLineCount + (padding.top + padding.bottom) / lineHeight;
		const pixelRatio = geometry.minimapCanvasInnerHeight / Math.max(1, geometry.minimapCanvasOuterHeight);
		this.contentHeight = Math.min(context.viewportHeight, Math.max(0, rows * geometry.minimapLineHeight / Math.max(1, pixelRatio)));
		this.sliderHeight = Math.min(this.contentHeight, Math.max(8, this.contentHeight * context.viewportHeight / Math.max(1, context.scrollHeight)));
		const scrollRange = Math.max(0, context.scrollHeight - context.viewportHeight);
		this.sliderTop = scrollRange > 0 ? context.scrollTop / scrollRange * (this.contentHeight - this.sliderHeight) : 0;
		this.domNode.classList.toggle('stanza-editor-minimap-hover-slider', minimap.showSlider === 'mouseover');
		this.domNode.style.left = `${context.scrollLeft + geometry.minimapLeft}px`;
		this.domNode.style.top = `${context.scrollTop}px`;
		this.domNode.style.width = `${geometry.minimapWidth}px`;
		this.domNode.style.height = `${context.viewportHeight}px`;
		this.slider.style.top = `${this.sliderTop}px`;
		this.slider.style.height = `${this.sliderHeight}px`;
		this.canvas.style.width = `${geometry.minimapCanvasOuterWidth}px`;
		this.canvas.style.height = `${geometry.minimapCanvasOuterHeight}px`;
		const width = Math.max(1, Math.round(geometry.minimapCanvasInnerWidth));
		const height = Math.max(1, Math.round(geometry.minimapCanvasInnerHeight));
		// Placement and the slider change during sash drags and scrolling without
		// changing the document raster. Setting canvas dimensions also clears it.
		const rasterKey = [
			width,
			height,
			geometry.minimapScale,
			geometry.minimapLineHeight,
			this.contentHeight,
			context.viewportHeight,
			padding.top,
			padding.bottom,
			this.source.model.version,
			this.source.model.getOptions().tabSize,
			this.source.readProjectionRevision(),
		].join(':');
		if (this.rasterDirty || this.rasterKey !== rasterKey) {
			if (this.canvas.width !== width) this.canvas.width = width;
			if (this.canvas.height !== height) this.canvas.height = height;
			this.paint(context, geometry);
			this.rasterKey = rasterKey;
			this.rasterDirty = false;
		}
	}

	private invalidateRaster(): boolean {
		this.rasterDirty = true;
		this.setShouldRender();
		return true;
	}

	private paint(context: RestrictedRenderingContext, geometry: EditorMinimapLayoutInfo): void {
		const painter = this.canvas.getContext('2d');
		if (!painter) return;
		const padding = this._context.configuration.options.get(EditorOption.padding);
		const tabSize = this.source.model.getOptions().tabSize;
		const width = this.canvas.width;
		const height = this.canvas.height;
		painter.clearRect(0, 0, width, height);
		const projection = this.source.readVisualProjection();
		const lineHeight = Math.max(1, this.source.readLayout().lineHeight);
		const paddingRows = padding.top / lineHeight;
		const scaleY = this.contentHeight * height / context.viewportHeight / Math.max(1, projection.visualLineCount + (padding.top + padding.bottom) / lineHeight);
		const fontInfo = this._context.configuration.options.get(EditorOption.fontInfo);
		const renderer = MinimapCharRendererFactory.create(geometry.minimapScale, fontInfo.fontFamily);
		const charWidth = Constants.BASE_CHAR_WIDTH * renderer.scale;
		const force1pxHeight = scaleY < Constants.BASE_CHAR_HEIGHT * renderer.scale;
		const glyphHeight = force1pxHeight ? 1 : Constants.BASE_CHAR_HEIGHT * renderer.scale;
		const innerLinePadding = Math.max(0, Math.floor((scaleY - glyphHeight) / 2));
		const colors = MinimapTokensColorTracker.getInstance();
		const hasTokenColors = (TokenizationRegistry.getColorMap()?.length ?? 0) > 2;
		const backgroundColor = this._context.theme.getColor(editorBackground)!.rgba;
		const foregroundColor = this._context.theme.getColor(editorForeground)!.rgba;
		const background = new RGBA8(backgroundColor.r, backgroundColor.g, backgroundColor.b, Math.round(backgroundColor.a * 255));
		const foreground = new RGBA8(foregroundColor.r, foregroundColor.g, foregroundColor.b, Math.round(foregroundColor.a * 255));
		const image = painter.createImageData(width, height);
		for (const line of projection.lines) {
			const text = this.source.model.getLineContent(line.logicalLineIndex + 1).slice(line.startColumn, line.endColumn);
			const y = Math.floor((line.visualLineIndex + paddingRows) * scaleY) + innerLinePadding;
			if (y + glyphHeight > height) {
				continue;
			}
			const tokens = this.source.model.tokenization.getLineTokens(line.logicalLineIndex + 1);
			let column = Math.round((line.wrappedTextIndentWidth ?? 0) / fontInfo.typicalHalfwidthCharacterWidth);
			for (let offset = 0; offset < text.length && (column + 1) * charWidth <= width; offset++) {
				const charCode = text.charCodeAt(offset);
				if (charCode === 9) {
					column += tabSize - column % tabSize;
					continue;
				}
				if (charCode === 32) {
					column++;
					continue;
				}
				const tokenIndex = tokens.findTokenIndexAtOffset(line.startColumn + offset);
				const color = hasTokenColors ? colors.getColor(tokens.getForeground(tokenIndex)) : foreground;
				const characterColumns = isFullWidthCharacter(charCode) ? 2 : 1;
				// Wide characters still occupy two cells when the compact font uses
				// a replacement glyph rather than a dedicated character bitmap.
				for (let cell = 0; cell < characterColumns && (column + 1) * charWidth <= width; cell++, column++) {
					const x = column * charWidth;
					const alpha = Math.round(color.a * 0.55);
					if (geometry.renderMinimap === RenderMinimap.Text) {
						renderer.renderChar(image, x, y, charCode, color, alpha, background, 0, renderer.scale, colors.backgroundIsLight(), force1pxHeight);
					} else {
						renderer.blockRenderChar(image, x, y, color, alpha, background, 0, force1pxHeight);
					}
				}
			}
		}
		painter.putImageData(image, 0, 0);

		const fullRange = new Range(1, 1, this._context.viewModel.getLineCount(), this._context.viewModel.getLineMaxColumn(this._context.viewModel.getLineCount()));
		for (const decoration of this._context.viewModel.getMinimapDecorationsInRange(fullRange)) {
			const minimap = decoration.options.minimap;
			if (!minimap?.color) continue;
			const color = typeof minimap.color === 'string' ? minimap.color : this._context.theme.getColor(minimap.color.id)?.toString();
			if (!color) continue;
			painter.fillStyle = color;
			const top = Math.floor((decoration.range.startLineNumber - 1) / Math.max(1, this._context.viewModel.getLineCount()) * height);
			const markerHeight = Math.max(2, Math.ceil((decoration.range.endLineNumber - decoration.range.startLineNumber + 1) * scaleY));
			painter.fillRect(Math.max(0, width - 3), top, 3, markerHeight);
		}

	}

	private moveTo(clientY: number): void {
		const bounds = this.domNode.getBoundingClientRect();
		if (bounds.height <= 0) return;
		const layout = this.source.readLayout();
		const travel = this.contentHeight - this.sliderHeight;
		const ratio = travel > 0 ? clamp((clientY - bounds.top - this.dragOffset) / travel, 0, 1) : 0;
		this.source.scrollTo({ left: layout.scrollPosition.left, top: ratio * layout.maximumScrollPosition.top });
	}
}
