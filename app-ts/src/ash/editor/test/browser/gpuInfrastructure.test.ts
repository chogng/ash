import { h } from '../../../base/browser/dom.js';
import assert from 'node:assert/strict';
import { test, suiteTeardown } from 'mocha';
import { JSDOM } from 'jsdom';
import { BufferDirtyTracker } from '../../browser/gpu/bufferDirtyTracker.js';
import { segmentContent } from '../../browser/gpu/contentSegmenter.js';
import { createObjectCollectionBuffer } from '../../browser/gpu/objectCollectionBuffer.js';
import { type TextureAtlas } from '../../browser/gpu/atlas/textureAtlas.js';
import { type GlyphRasterizer } from '../../browser/gpu/raster/glyphRasterizer.js';
import { RectangleRenderer } from '../../browser/gpu/rectangleRenderer.js';
import { DecorationStyleCache } from '../../browser/gpu/css/decorationStyleCache.js';
import { type ViewContext } from '../../common/viewModel/viewContext.js';
import { type ViewGpuContext } from '../../browser/gpu/viewGpuContext.js';
import { ViewLineRenderingData } from '../../common/viewModel.js';
import { TextDirection } from '../../common/model.js';
import { ColorId, StandardTokenType, type ITokenPresentation } from '../../common/encodedTokenAttributes.js';
import { type IViewLineTokens } from '../../common/tokens/lineTokens.js';
import { type ViewportData } from '../../common/viewLayout/viewLinesViewportData.js';
import { type ViewLineOptions } from '../../browser/viewParts/viewLines/viewLineOptions.js';
import { observableValue } from '../../../base/common/observable.js';
import { Emitter } from '../../../base/common/event.js';
import { darkColorTheme } from '../../../platform/theme/common/colorTheme.js';
import { createColorTheme } from '../../../platform/theme/common/colorTheme.js';
import { ColorScheme } from '../../../platform/theme/common/theme.js';
import { FontStyle, TokenMetadata } from '../../common/encodedTokenAttributes.js';
import { SemanticTokenStyleResolver } from '../../browser/gpu/semanticTokenStyle.js';
import { EditorTheme } from '../../common/editorTheme.js';
import { EditorOption } from '../../common/config/editorOptions.js';
import { installEditorTestDom, installEditorTestGlobals } from './editorTestGlobals.js';

const browserEnvironment = new JSDOM('<!doctype html><body></body>');
const installedGlobals = installEditorTestDom(browserEnvironment, ['Node', 'Element', 'HTMLElement']);
suiteTeardown(() => {
	installedGlobals.dispose();
	browserEnvironment.window.close();
});

test('BufferDirtyTracker exposes one inclusive dirty range', () => {
	const tracker = new BufferDirtyTracker();
	assert.equal(tracker.isDirty, false);

	tracker.flag(8, 3);
	tracker.flag(2, 2);

	assert.deepEqual({ offset: tracker.dataOffset, size: tracker.dirtySize, dirty: tracker.isDirty }, { offset: 2, size: 9, dirty: true });
	tracker.clear();
	assert.deepEqual({ offset: tracker.dataOffset, size: tracker.dirtySize, dirty: tracker.isDirty }, { offset: undefined, size: undefined, dirty: false });
});

test('ObjectCollectionBuffer grows and compacts managed entries', () => {
	using collection = createObjectCollectionBuffer([{ name: 'x' }, { name: 'y' }] as const, 1);
	using first = collection.createEntry({ x: 1, y: 2 });
	using second = collection.createEntry({ x: 3, y: 4 });

	assert.equal(collection.entryCount, 2);
	assert.deepEqual([...collection.view.slice(0, collection.viewUsedSize)], [1, 2, 3, 4]);
	first.dispose();
	assert.equal(collection.entryCount, 1);
	assert.deepEqual([...collection.view.slice(0, collection.viewUsedSize)], [3, 4]);

	second.set('y', 9);
	assert.equal(second.get('y'), 9);
});

test('ContentSegmenter returns one entry for a complete grapheme', () => {
	const text = 'A👩‍💻B';
	const segmenter = segmentContent(text, false, false);

	assert.equal(segmenter.getSegmentAtIndex(0), 'A');
	assert.equal(segmenter.getSegmentAtIndex(1), '👩‍💻');
	assert.equal(segmenter.getSegmentAtIndex(2), undefined);
	assert.equal(segmenter.getSegmentAtIndex(text.length - 1), 'B');
});

test('Full-file GPU strategy writes canonical cells and draws from the document row', async () => {
	const { FullFileRenderStrategy } = await import('../../browser/gpu/renderStrategy/fullFileRenderStrategy.js');
	withGpuBufferUsage(() => {
		const harness = createStrategyHarness();
		using strategy = new FullFileRenderStrategy(harness.context, harness.gpuContext, harness.device, { value: harness.rasterizer });
		const viewportData = viewport(['ab'], 4, 7);

		const objectCount = strategy.update(viewportData, viewLineOptions());
		const cellWrite = harness.writes.find(write => write.label === 'Ash full-file GPU cells');
		assert.equal(objectCount, FullFileRenderStrategy.maxSupportedColumns);
		assert.equal(cellWrite?.offset, 3 * 6 * FullFileRenderStrategy.maxSupportedColumns * Float32Array.BYTES_PER_ELEMENT);
		assert.deepEqual(cellWrite?.values.slice(0, 12), [0, 13, 0, 0, 1, 0, 8, 13, 0, 0, 1, 0]);

		let drawArguments: readonly number[] | undefined;
		strategy.draw({ draw: (...args: number[]) => { drawArguments = args; } } as unknown as GPURenderPassEncoder, viewportData);
		assert.deepEqual(drawArguments, [6, FullFileRenderStrategy.maxSupportedColumns, 0, 3 * FullFileRenderStrategy.maxSupportedColumns]);
	});
});

test('Viewport GPU strategy preserves tab stops and complete grapheme cells', async () => {
	const { ViewportRenderStrategy } = await import('../../browser/gpu/renderStrategy/viewportRenderStrategy.js');
	withGpuBufferUsage(() => {
		const harness = createStrategyHarness();
		using strategy = new ViewportRenderStrategy(harness.context, harness.gpuContext, harness.device, { value: harness.rasterizer });
		const content = 'a\t👩‍💻b';
		const objectCount = strategy.update(viewport([content]), viewLineOptions());
		const cellWrite = [...harness.writes].reverse().find(write => write.label === 'Ash viewport GPU cells');
		const cells = cellWrite!.values;

		assert.equal(objectCount, ViewportRenderStrategy.maxSupportedColumns);
		assert.deepEqual([
			cells[0],
			cells[2 * 6],
			cells[3 * 6],
			cells[7 * 6],
		], [0, 32, 0, 40]);
		assert.deepEqual([
			cells[4],
			cells[2 * 6 + 4],
			cells[3 * 6 + 4],
			cells[7 * 6 + 4],
		], [1, 1, 0, 1]);
	});
});

test('GPU strategies send semantic colors and font styles to the glyph atlas', async () => {
	const { ViewportRenderStrategy } = await import('../../browser/gpu/renderStrategy/viewportRenderStrategy.js');
	const { FullFileRenderStrategy } = await import('../../browser/gpu/renderStrategy/fullFileRenderStrategy.js');
	const { ViewGpuContext } = await import('../../browser/gpu/viewGpuContext.js');
	const theme = createColorTheme({ id: 'gpu-semantic-test', label: 'GPU semantic test', colorScheme: ColorScheme.Dark, semanticTokenRules: [
		{ selector: 'variable', type: 'variable', modifiers: [], foreground: '#123456', fontStyle: 'italic underline' },
	] });
	const resolver = new SemanticTokenStyleResolver(theme, true);
	withGpuBufferUsage(() => {
		for (const Strategy of [ViewportRenderStrategy, FullFileRenderStrategy]) {
			const harness = createStrategyHarness();
			Object.assign(harness.gpuContext, {
				getSemanticTokens: () => [{ startColumn: 1, endColumn: 2, semanticType: 'variable', semanticModifiers: [] }],
				resolveSemanticStyle: resolver.resolve.bind(resolver),
			});
			using strategy = new Strategy(harness.context, harness.gpuContext, harness.device, { value: harness.rasterizer });
			strategy.update(viewport(['ab']), viewLineOptions());
			assert.equal(harness.glyphs.length, 2);
			assert.equal(harness.glyphs[0]?.styleSetId, 0);
			assert.equal(TokenMetadata.getFontStyle(harness.glyphs[1]!.metadata), FontStyle.Italic | FontStyle.Underline);
			assert.equal(ViewGpuContext.decorationStyleCache.getStyleSet(harness.glyphs[1]!.styleSetId)?.color, 0x123456ff);
		}
	});
});

test('semantic GPU rules follow type, modifier, language, and highlighting preference', () => {
	const theme = createColorTheme({ id: 'gpu-semantic-specificity', label: 'GPU semantic specificity', colorScheme: ColorScheme.Dark, semanticTokenRules: [
		{ selector: '*.declaration', type: '*', modifiers: ['declaration'], foreground: '#112233' },
		{ selector: 'variable', type: 'variable', modifiers: [], foreground: '#445566' },
		{ selector: 'variable.declaration:typescript', type: 'variable', modifiers: ['declaration'], language: 'typescript', foreground: '#778899', fontStyle: 'bold' },
	] });
	const token = { startColumn: 0, endColumn: 1, semanticType: 'variable', semanticModifiers: ['declaration'], semanticLanguage: 'typescript' };
	const enabled = new SemanticTokenStyleResolver(theme, true).resolve(token, 0);
	const disabled = new SemanticTokenStyleResolver(theme, false).resolve(token, 0);
	assert.deepEqual({ color: enabled.color, style: TokenMetadata.getFontStyle(enabled.tokenMetadata) }, { color: 0x778899ff, style: FontStyle.Bold });
	assert.deepEqual(disabled, { tokenMetadata: 0, color: undefined });
});

test('Rectangle GPU rendering draws a clear pass into the caller-owned frame', async () => {
	const installedUsage = installEditorTestGlobals({ GPUBufferUsage: { COPY_DST: 1, STORAGE: 2, UNIFORM: 4, VERTEX: 8 } });
	const passes: GPURenderPassDescriptor[] = [];
	let ended = false;
		const device = {
			queue: {
				writeBuffer: () => undefined,
				submit: () => undefined,
			},
			createBuffer: () => ({ destroy: () => undefined }),
			createShaderModule: () => ({}),
			createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
			createBindGroup: () => ({}),
			createCommandEncoder: () => encoder,
		} as unknown as GPUDevice;
		const encoder = {
				beginRenderPass: (descriptor: GPURenderPassDescriptor) => {
					passes.push(descriptor);
					return { end: () => { ended = true; } };
				},
				finish: () => ({}),
			} as unknown as GPUCommandEncoder;
		const view = {} as GPUTextureView;
		let eventHandlerCount = 0;
		const context = {
			addEventHandler: () => { eventHandlerCount++; },
			removeEventHandler: () => { eventHandlerCount--; },
			viewLayout: {
				getCurrentScrollLeft: () => 10,
				getCurrentScrollTop: () => 20,
			},
		} as unknown as ViewContext;
		const canvas = h(browserEnvironment.window.document, 'canvas');
		canvas.width = 800;
		canvas.height = 600;
		Object.defineProperty(canvas.ownerDocument.defaultView!.navigator, 'gpu', {
			configurable: true,
			value: { getPreferredCanvasFormat: () => 'bgra8unorm' },
		});
		let configured = false;
		const canvasContext = {
			configure: () => { configured = true; },
			getCurrentTexture: () => ({ createView: () => view }),
		} as unknown as GPUCanvasContext;

		try {
			const renderer = new RectangleRenderer(context, observableValue('contentLeft', 0), observableValue('devicePixelRatio', 1), canvas, canvasContext, Promise.resolve(device));
			await Promise.resolve();
			assert.equal(eventHandlerCount, 1);
			assert.equal(configured, true);
			renderer.draw({ bigNumbersDelta: 0 } as ViewportData);
			const attachment = [...(passes[0]?.colorAttachments ?? [])][0] as GPURenderPassColorAttachment | undefined;
		assert.deepEqual({
			passCount: passes.length,
			view: attachment?.view,
			loadOp: attachment?.loadOp,
			storeOp: attachment?.storeOp,
			clearValue: attachment?.clearValue,
			ended,
		}, {
			passCount: 1,
			view,
			loadOp: 'clear',
			storeOp: 'store',
			clearValue: { r: 0, g: 0, b: 0, a: 0 },
				ended: true,
			});
			renderer.dispose();
			assert.equal(eventHandlerCount, 0);
		} finally {
		installedUsage.dispose();
	}
});

test('ViewGpuContext exposes observable canvas geometry and releases view handlers', async () => {
	const resizeCallbacks: ResizeObserverCallback[] = [];
	let disconnected = false;
	class TestResizeObserver implements ResizeObserver {
		constructor(callback: ResizeObserverCallback) { resizeCallbacks.push(callback); }
		public observe(): void {}
		public unobserve(): void {}
		public disconnect(): void { disconnected = true; }
		public takeRecords(): ResizeObserverEntry[] { return []; }
	}
	const canvasContext = { configure: () => undefined } as unknown as GPUCanvasContext;
	const canvasPrototype = browserEnvironment.window.HTMLCanvasElement.prototype;
	const originalGetContext = Object.getOwnPropertyDescriptor(canvasPrototype, 'getContext');
	const originalResizeObserver = Object.getOwnPropertyDescriptor(browserEnvironment.window, 'ResizeObserver');
	const originalGpu = Object.getOwnPropertyDescriptor(browserEnvironment.window.navigator, 'gpu');
	Object.defineProperty(canvasPrototype, 'getContext', {
		configurable: true,
		value: (type: string) => type === 'webgpu' ? canvasContext : null,
	});
	Object.defineProperty(browserEnvironment.window, 'ResizeObserver', { configurable: true, value: TestResizeObserver });
	Object.defineProperty(browserEnvironment.window.navigator, 'gpu', {
		configurable: true,
		value: {
			getPreferredCanvasFormat: () => 'bgra8unorm',
			requestAdapter: () => new Promise<GPUAdapter | null>(() => {}),
		},
	});
	const configurationEmitter = new Emitter<{ hasChanged(option: EditorOption): boolean }>();
	const state = { contentLeft: 24, verticalScrollbarSize: 12 };
	const handlers = new Set<object>();
	const context = {
		configuration: {
			onDidChange: configurationEmitter.event,
			options: {
				get(option: EditorOption) {
					if (option === EditorOption.layoutInfo) return { contentLeft: state.contentLeft };
					if (option === EditorOption.scrollbar) return { verticalScrollbarSize: state.verticalScrollbarSize };
					throw new RangeError(`Unexpected editor option: ${option}`);
				},
			},
		},
		theme: new EditorTheme(darkColorTheme),
		addEventHandler: (handler: object) => handlers.add(handler),
		removeEventHandler: (handler: object) => handlers.delete(handler),
		viewLayout: {},
	} as unknown as ViewContext;

	try {
		const { ViewGpuContext } = await import('../../browser/gpu/viewGpuContext.js');
		const gpuContext = new ViewGpuContext(context);
		browserEnvironment.window.document.body.append(gpuContext.canvas.domNode);
		assert.deepEqual({
			className: gpuContext.canvas.domNode.className,
			ariaHidden: gpuContext.canvas.domNode.getAttribute('aria-hidden'),
			context: gpuContext.ctx,
			devicePixelRatio: gpuContext.devicePixelRatio.get(),
			contentLeft: gpuContext.contentLeft.get(),
			dimensions: gpuContext.canvasDevicePixelDimensions.get(),
			paddingRight: gpuContext.canvas.domNode.style.paddingRight,
			handlerCount: handlers.size,
		}, {
			className: 'stanza-editor-gpu-canvas',
			ariaHidden: 'true',
			context: canvasContext,
			devicePixelRatio: 1,
			contentLeft: 24,
			dimensions: { width: 300, height: 150 },
			paddingRight: '12px',
			handlerCount: 2,
		});

		resizeCallbacks[0]!([{
			target: gpuContext.canvas.domNode,
			devicePixelContentBoxSize: [{ inlineSize: 640, blockSize: 480 }],
		} as unknown as ResizeObserverEntry], {} as ResizeObserver);
		state.contentLeft = 40;
		state.verticalScrollbarSize = 16;
		configurationEmitter.fire({ hasChanged: option => option === EditorOption.layoutInfo || option === EditorOption.scrollbar });
		assert.deepEqual({
			dimensions: gpuContext.canvasDevicePixelDimensions.get(),
			contentLeft: gpuContext.contentLeft.get(),
			paddingRight: gpuContext.canvas.domNode.style.paddingRight,
		}, {
			dimensions: { width: 640, height: 480 },
			contentLeft: 40,
			paddingRight: '16px',
		});

		gpuContext.dispose();
		assert.deepEqual({ handlerCount: handlers.size, disconnected, connected: gpuContext.canvas.domNode.isConnected }, { handlerCount: 0, disconnected: true, connected: false });
	} finally {
		configurationEmitter.dispose();
		if (originalGetContext) Object.defineProperty(canvasPrototype, 'getContext', originalGetContext);
		if (originalResizeObserver) Object.defineProperty(browserEnvironment.window, 'ResizeObserver', originalResizeObserver);
		else Reflect.deleteProperty(browserEnvironment.window, 'ResizeObserver');
		if (originalGpu) Object.defineProperty(browserEnvironment.window.navigator, 'gpu', originalGpu);
		else Reflect.deleteProperty(browserEnvironment.window.navigator, 'gpu');
	}
});

function fixedGlyphAtlas(): TextureAtlas {
	return {
		getGlyph: () => ({
			pageIndex: 0,
				glyphIndex: 1,
			x: 0,
			y: 0,
			w: 8,
			h: 10,
			originOffsetX: 0,
			originOffsetY: 0,
			fontBoundingBoxAscent: 8,
			fontBoundingBoxDescent: 2,
		}),
	} as unknown as TextureAtlas;
}

interface BufferWrite {
	readonly label: string;
	readonly offset: number;
	readonly values: number[];
}

function createStrategyHarness(): {
	readonly context: ViewContext;
	readonly gpuContext: ViewGpuContext;
	readonly device: GPUDevice;
	readonly rasterizer: GlyphRasterizer;
	readonly writes: BufferWrite[];
	readonly glyphs: { readonly chars: string; readonly metadata: number; readonly styleSetId: number }[];
} {
	const writes: BufferWrite[] = [];
	const glyphs: { chars: string; metadata: number; styleSetId: number }[] = [];
	const labels = new WeakMap<object, string>();
	const device = {
		queue: {
			writeBuffer: (buffer: object, offset: number, data: AllowSharedBufferSource, dataOffset?: number, size?: number) => {
				let values: Float32Array;
				if (data instanceof ArrayBuffer) {
					const byteOffset = dataOffset ?? 0;
					values = new Float32Array(data, byteOffset, size === undefined ? undefined : size / Float32Array.BYTES_PER_ELEMENT);
				} else {
					const view = data as ArrayBufferView;
					values = new Float32Array(view.buffer, view.byteOffset, view.byteLength / Float32Array.BYTES_PER_ELEMENT);
				}
				writes.push({ label: labels.get(buffer) ?? '', offset, values: [...values] });
			},
		},
		createBuffer: (descriptor: GPUBufferDescriptor) => {
			const buffer = { destroy: () => undefined };
			labels.set(buffer, descriptor.label?.toString() ?? '');
			return buffer;
		},
	} as unknown as GPUDevice;
	const context = {
		addEventHandler: () => undefined,
		removeEventHandler: () => undefined,
		viewLayout: {
			getCurrentScrollLeft: () => 0,
			getCurrentScrollTop: () => 0,
		},
	} as unknown as ViewContext;
	const gpuContext = {
		devicePixelRatio: observableValue('devicePixelRatio', 1),
		atlas: { getGlyph: (_rasterizer: GlyphRasterizer, chars: string, metadata: number, styleSetId: number) => {
			glyphs.push({ chars, metadata, styleSetId });
			return fixedGlyphAtlas().getGlyph(_rasterizer, chars, metadata, styleSetId, 0);
		} },
		decorationStyleCache: new DecorationStyleCache(),
		decorationCssRuleExtractor: { getStyleRules: () => [] },
		canvas: {},
		canRender: () => true,
		getSemanticTokens: () => [],
		resolveSemanticStyle: (_token: unknown, metadata: number) => ({ tokenMetadata: metadata, color: undefined }),
	} as unknown as ViewGpuContext;
	const rasterizer = {
		devicePixelRatio: 1,
		getTextMetrics: () => ({ width: 8 }),
	} as unknown as GlyphRasterizer;
	return { context, gpuContext, device, rasterizer, writes, glyphs };
}

function viewport(contents: readonly string[], startLineNumber = 1, bigNumbersDelta = 0): ViewportData {
	const lines = contents.map(content => new ViewLineRenderingData(
		1,
		content.length + 1,
		content,
		false,
		false,
		true,
		lineTokens(content),
		[],
		4,
		0,
		TextDirection.LTR,
		false,
	));
	return {
		startLineNumber,
		endLineNumber: startLineNumber + lines.length - 1,
		relativeVerticalOffset: lines.map((_, index) => index * 20),
		bigNumbersDelta,
		lineHeight: 20,
		getViewLineRenderingData: (lineNumber: number) => lines[lineNumber - startLineNumber]!,
	} as unknown as ViewportData;
}

function viewLineOptions(): ViewLineOptions {
	return {
		spaceWidth: 8,
		useMonospaceOptimizations: false,
		fontLigatures: '',
	} as ViewLineOptions;
}

function lineTokens(content: string): IViewLineTokens {
	const tokens: IViewLineTokens = {
		languageIdCodec: { encodeLanguageId: () => 0, decodeLanguageId: () => 'plaintext' },
		equals: other => other === tokens,
		getCount: () => 1,
		getStandardTokenType: () => StandardTokenType.Other,
		getForeground: () => ColorId.DefaultForeground,
		getEndOffset: () => content.length,
		getClassName: () => '',
		getInlineStyle: () => '',
		getPresentation: (): ITokenPresentation => ({ foreground: ColorId.DefaultForeground, italic: false, bold: false, underline: false, strikethrough: false }),
		findTokenIndexAtOffset: () => 0,
		getLineContent: () => content,
		getMetadata: () => 0,
		getLanguageId: () => 'plaintext',
		getTokenText: () => content,
		forEach: callback => callback(0),
	};
	return tokens;
}

function withGpuBufferUsage(callback: () => void): void {
	const installedUsage = installEditorTestGlobals({ GPUBufferUsage: { COPY_DST: 1, STORAGE: 2, UNIFORM: 4, VERTEX: 8 } });
	try {
		callback();
	} finally {
		installedUsage.dispose();
	}
}
