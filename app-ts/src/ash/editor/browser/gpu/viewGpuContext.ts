import { h, addDisposableListener, getActiveWindow } from '../../../base/browser/dom.js';
import { createFastDomNode, type FastDomNode } from '../../../base/browser/fastDomNode.js';
import { PixelRatio } from '../../../base/browser/pixelRatio.js';
import { Color } from '../../../base/common/color.js';
import { Disposable, toDisposable, type IDisposable, type IReference } from '../../../base/common/lifecycle.js';
import { observableValue, type IObservable } from '../../../base/common/observable.js';
import { editorBackground, editorForeground } from '../../../platform/theme/common/colors/editorColors.js';
import { type IColorTheme } from '../../../platform/theme/common/colorTheme.js';
import { EditorFontLigatures, EditorOption } from '../../common/config/editorOptions.js';
import { ColorId } from '../../common/encodedTokenAttributes.js';
import { ViewEventHandler } from '../../common/viewEventHandler.js';
import { type ViewThemeChangedEvent } from '../../common/viewEvents.js';
import { type ViewportData } from '../../common/viewLayout/viewLinesViewportData.js';
import { InlineDecorationType } from '../../common/viewModel/inlineDecorations.js';
import { type ViewContext } from '../../common/viewModel/viewContext.js';
import { type ViewLineOptions } from '../viewParts/viewLines/viewLineOptions.js';
import { TextureAtlas } from './atlas/textureAtlas.js';
import { DecorationCssRuleExtractor } from './css/decorationCssRuleExtractor.js';
import { DecorationStyleCache } from './css/decorationStyleCache.js';
import { GPULifecycle } from './gpuDisposable.js';
import { ensureNonNullable, observeDevicePixelDimensions } from './gpuUtils.js';
import { RectangleRenderer } from './rectangleRenderer.js';

let sharedDeviceReference: IReference<GPUDevice> | undefined;
let sharedDevicePagehideListener: IDisposable | undefined;

/** Owns the WebGPU surface and shared renderer contracts used by one editor view. */
export class ViewGpuContext extends Disposable {
	public readonly maxGpuCols = 2_000;
	public readonly canvas: FastDomNode<HTMLCanvasElement>;
	public readonly ctx: GPUCanvasContext;

	public static device: Promise<GPUDevice>;
	public static deviceSync: GPUDevice | undefined;

	public readonly rectangleRenderer: RectangleRenderer;

	private static readonly _decorationCssRuleExtractor = new DecorationCssRuleExtractor();
	public static get decorationCssRuleExtractor(): DecorationCssRuleExtractor { return ViewGpuContext._decorationCssRuleExtractor; }

	private static readonly _decorationStyleCache = new DecorationStyleCache();
	public static get decorationStyleCache(): DecorationStyleCache { return ViewGpuContext._decorationStyleCache; }

	private static readonly _colorMap: string[] = [];
	private static _atlas: TextureAtlas | undefined;

	public static get atlas(): TextureAtlas {
		if (!ViewGpuContext._atlas) throw new Error('WebGPU texture atlas is not ready');
		return ViewGpuContext._atlas;
	}

	public get atlas(): TextureAtlas { return ViewGpuContext.atlas; }

	public readonly canvasDevicePixelDimensions: IObservable<{ width: number; height: number }>;
	public readonly devicePixelRatio: IObservable<number>;
	public readonly contentLeft: IObservable<number>;

	constructor(context: ViewContext) {
		super();
		const ownerWindow = getActiveWindow();
		this.canvas = createFastDomNode(h(ownerWindow.document, 'canvas'));
		this.canvas.setClassName('stanza-editor-gpu-canvas');
		this.canvas.setAttribute('aria-hidden', 'true');
		this._register(toDisposable(() => this.canvas.domNode.remove()));
		this.updateCanvasPadding(context);
		this._register(context.configuration.onDidChange(event => {
			if (event.hasChanged(EditorOption.scrollbar)) this.updateCanvasPadding(context);
		}));

		this.ctx = ensureNonNullable(this.canvas.domNode.getContext('webgpu'));
		ViewGpuContext.updateTheme(context.theme.value);
		this._register(new GpuThemeListener(context, theme => ViewGpuContext.updateTheme(theme)));

		if (!ViewGpuContext.device) {
			ViewGpuContext.device = GPULifecycle.requestDevice(ownerWindow).then(reference => {
				sharedDeviceReference = reference;
				ViewGpuContext.deviceSync = reference.object;
				ViewGpuContext._atlas = new TextureAtlas(
					reference.object.limits.maxTextureDimension2D,
					undefined,
					ViewGpuContext.decorationStyleCache,
					ViewGpuContext._colorMap,
				);
				return reference.object;
			});
			sharedDevicePagehideListener = addDisposableListener(ownerWindow, 'pagehide', () => ViewGpuContext.disposeSharedResources(), { once: true });
		}

		const pixelRatio = PixelRatio.getInstance(ownerWindow);
		const devicePixelRatio = observableValue(this, pixelRatio.value);
		this._register(pixelRatio.onDidChange(value => devicePixelRatio.set(value)));
		this._register(devicePixelRatio.onDidChange(() => ViewGpuContext._atlas?.clear()));
		this.devicePixelRatio = devicePixelRatio;

		const canvasDevicePixelDimensions = observableValue(this, {
			width: this.canvas.domNode.width,
			height: this.canvas.domNode.height,
		});
		this._register(observeDevicePixelDimensions(this.canvas.domNode, ownerWindow, (width, height) => {
			this.canvas.domNode.width = width;
			this.canvas.domNode.height = height;
			canvasDevicePixelDimensions.set({ width, height });
		}));
		this.canvasDevicePixelDimensions = canvasDevicePixelDimensions;

		const contentLeft = observableValue(this, context.configuration.options.get(EditorOption.layoutInfo).contentLeft);
		this._register(context.configuration.onDidChange(event => {
			if (event.hasChanged(EditorOption.layoutInfo)) contentLeft.set(context.configuration.options.get(EditorOption.layoutInfo).contentLeft);
		}));
		this.contentLeft = contentLeft;

		this.rectangleRenderer = this._register(new RectangleRenderer(
			context,
			this.contentLeft,
			this.devicePixelRatio,
			this.canvas.domNode,
			this.ctx,
			ViewGpuContext.device,
		));
	}

	public canRender(options: ViewLineOptions, viewportData: ViewportData, lineNumber: number): boolean {
		return this.canRenderDetailed(options, viewportData, lineNumber).length === 0;
	}

	public canRenderDetailed(options: ViewLineOptions, viewportData: ViewportData, lineNumber: number): string[] {
		const line = viewportData.getViewLineRenderingData(lineNumber);
		const reasons: string[] = [];
		if (line.containsRTL) reasons.push('contains RTL text');
		if (line.maxColumn > this.maxGpuCols) reasons.push('line is too long');
		for (const decoration of line.inlineDecorations) {
			if (decoration.type !== InlineDecorationType.Regular) {
				reasons.push(`unsupported inline decoration type: ${decoration.type}`);
				continue;
			}
			for (const rule of ViewGpuContext.decorationCssRuleExtractor.getStyleRules(this.canvas.domNode, decoration.inlineClassName)) {
				if (rule.selectorText.includes(':')) {
					reasons.push(`unsupported inline decoration selector: ${rule.selectorText}`);
					continue;
				}
				for (const property of rule.style) {
					if (!supportsDecorationCssRule(property, rule.style)) reasons.push(`unsupported inline decoration CSS: ${property}`);
				}
			}
		}
		if (options.fontLigatures !== EditorFontLigatures.OFF) reasons.push('uses font ligatures');
		return reasons;
	}

	private updateCanvasPadding(context: ViewContext): void {
		this.canvas.domNode.style.boxSizing = 'border-box';
		this.canvas.domNode.style.paddingRight = `${context.configuration.options.get(EditorOption.scrollbar).verticalScrollbarSize}px`;
	}

	private static updateTheme(theme: IColorTheme): void {
		const foreground = theme.getColor(editorForeground);
		const background = theme.getColor(editorBackground);
		if (!foreground || !background) throw new Error('The editor theme must define GPU foreground and background colors');
		const nextForeground = foreground.toString();
		const nextBackground = background.toString();
		ViewGpuContext._colorMap[ColorId.DefaultForeground] = nextForeground;
		ViewGpuContext._colorMap[ColorId.DefaultBackground] = nextBackground;
		// Decoration colors can change while the base text colors stay the same.
		ViewGpuContext.decorationCssRuleExtractor.clear();
		ViewGpuContext._atlas?.clear();
	}

	private static disposeSharedResources(): void {
		sharedDevicePagehideListener?.dispose();
		sharedDevicePagehideListener = undefined;
		ViewGpuContext._atlas?.dispose();
		ViewGpuContext._atlas = undefined;
		sharedDeviceReference?.dispose();
		sharedDeviceReference = undefined;
		ViewGpuContext.deviceSync = undefined;
	}
}

class GpuThemeListener extends ViewEventHandler {
	constructor(private readonly context: ViewContext, private readonly update: (theme: IColorTheme) => void) {
		super();
		this.context.addEventHandler(this);
		this._register(toDisposable(() => this.context.removeEventHandler(this)));
	}

	public override onThemeChanged(event: ViewThemeChangedEvent): boolean {
		this.update(event.theme);
		return true;
	}
}

const supportedDecorationCssRules = new Set([
	'color',
	'font-weight',
	'opacity',
	'text-decoration',
	'text-decoration-color',
	'text-decoration-line',
	'text-decoration-style',
	'text-decoration-thickness',
]);

function supportsDecorationCssRule(property: string, style: CSSStyleDeclaration): boolean {
	if (!supportedDecorationCssRules.has(property)) return false;
	const value = style.getPropertyValue(property).trim();
	switch (property) {
		case 'text-decoration':
		case 'text-decoration-line': return value === 'line-through';
		case 'text-decoration-color': return /^var\(--[^,)]+(?:,[^)]+)?\)$/.test(value) || Color.Format.CSS.parse(value) !== null;
		case 'text-decoration-style': return value === 'initial' || value === 'solid';
		case 'text-decoration-thickness': return value === 'initial' || /^\d+(?:\.\d+)?px$/.test(value);
		default: return true;
	}
}
