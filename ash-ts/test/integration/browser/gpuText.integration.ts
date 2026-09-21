import { DisposableStore, toDisposable } from '../../../src/ash/base/common/lifecycle.js';
import * as stanzaApi from '../../../src/ash/editor/editor.main.js';
import { GlyphRasterizer } from '../../../src/ash/editor/browser/gpu/raster/glyphRasterizer.js';
import { DecorationStyleCache } from '../../../src/ash/editor/browser/gpu/css/decorationStyleCache.js';
import { ViewGpuContext } from '../../../src/ash/editor/browser/gpu/viewGpuContext.js';
import '../../../src/ash/editor/editor.code.all.js';

const initialText = `interface GeometrySample {
	readonly label: string;
	readonly columns: readonly number[];
}

const greeting = "你好，Stanza 👋";
const sample: GeometrySample = {
	label: greeting,
	columns: [0, 4, 8, 16, 32, 64, 80],
};

export function describe(sample: GeometrySample): string {
	const longLine = "Edit this deliberately long line to inspect wrapping, cursor placement, selections, horizontal geometry, and viewport updates without starting the Ash Workbench.";
	return \`\${sample.label}: \${sample.columns.join(", ")} — \${longLine}\`;
}

console.log(describe(sample));
`;

interface GpuTextIntegrationHarness {
	readonly initialText: string;
	getValue(): string;
	setFontLigatures(enabled: boolean): void;
	measureGpuAdvance(text: string): number;
	resetGpuFrameTrace(): void;
	readGpuFrameTrace(): readonly GpuRenderPassTrace[];
	setBracketColor(color: string): void;
	prepareBracketText(length: number): void;
	countGlyphPixels(red: number, green: number, blue: number): number;
	dispose(): void;
}

interface GpuRenderPassTrace {
	readonly label: string;
	readonly loadOp: GPULoadOp;
	readonly viewId: number;
	readonly submissionId: number;
}

interface GpuFrameTraceController {
	reset(): void;
	read(): readonly GpuRenderPassTrace[];
	dispose(): void;
}

declare global {
	interface Window {
		ashGpuTextIntegration: GpuTextIntegrationHarness;
	}
}

const container = requiredElement('editor-root');
const disposables = new DisposableStore();
const gpuFrameTrace = installGpuFrameTrace();
disposables.add(toDisposable(() => gpuFrameTrace.dispose()));
const resource = stanzaApi.URI.parse('inmemory://stanza/gpu-integration.ts');
const model = disposables.add(stanzaApi.editor.createModel(initialText, 'typescript', resource));
const editor = disposables.add(stanzaApi.editor.create(container, {
	model,
	lineWrapping: stanzaApi.EditorLineWrapping.On,
	lineNumbers: 'on',
	guides: { indentation: true },
	bracketPairColorization: { enabled: true },
	experimentalGpuAcceleration: 'on',
}));
const resizeObserver = new ResizeObserver(() => editor.layout({ width: container.clientWidth, height: container.clientHeight }));
resizeObserver.observe(container);
disposables.add(toDisposable(() => resizeObserver.disconnect()));
editor.layout({ width: container.clientWidth, height: container.clientHeight });
editor.focus();

window.ashGpuTextIntegration = {
	setFontLigatures: enabled => editor.updateOptions({ fontLigatures: enabled }),
	initialText,
	getValue: () => editor.getValue(),
	measureGpuAdvance: text => measureGpuAdvance(text),
	resetGpuFrameTrace: () => gpuFrameTrace.reset(),
	readGpuFrameTrace: () => gpuFrameTrace.read(),
	prepareBracketText: length => {
		editor.updateOptions({ wordWrap: 'off' });
		editor.setValue(`(${'x'.repeat(length)})`);
	},
	setBracketColor: color => {
		stanzaApi.editor.defineNamedTheme('gpu-brackets', {
			label: 'GPU brackets',
			colorScheme: stanzaApi.ColorScheme.Dark,
			colors: Object.fromEntries([1, 2, 3, 4, 5, 6].map(level => [`editorBracketHighlight.foreground${level}`, color])),
		});
		stanzaApi.editor.setTheme('gpu-brackets');
	},
	countGlyphPixels: (red, green, blue) => {
		let count = 0;
		for (const page of ViewGpuContext.atlas.pages) {
			const context = page.source.getContext('2d');
			if (!context) {
				throw new Error('Glyph atlas has no 2D context');
			}
			const pixels = context.getImageData(0, 0, page.source.width, page.source.height).data;
			for (let index = 0; index < pixels.length; index += 4) {
				if (pixels[index] === red && pixels[index + 1] === green && pixels[index + 2] === blue && pixels[index + 3]! > 0) {
					count++;
				}
			}
		}
		return count;
	},
	dispose: () => disposables.dispose(),
};

function measureGpuAdvance(text: string): number {
	const editorElement = container.querySelector<HTMLElement>('.stanza-editor');
	if (!editorElement) throw new Error('GPU integration editor is missing');
	const style = getComputedStyle(editorElement);
	using rasterizer = new GlyphRasterizer(Number.parseFloat(style.fontSize), style.fontFamily, devicePixelRatio, new DecorationStyleCache());
	const letterSpacing = style.letterSpacing === 'normal' ? 0 : Number.parseFloat(style.letterSpacing) || 0;
	return [...text].reduce((width, character) => width + rasterizer.getTextMetrics(character).width / devicePixelRatio + letterSpacing, 0);
}

function installGpuFrameTrace(): GpuFrameTraceController {
	const gpu = navigator.gpu;
	if (!gpu) throw new Error('GPU integration test requires WebGPU');
	const originalRequestAdapter = gpu.requestAdapter;
	let passes: GpuRenderPassTrace[] = [];
	let viewIds = new WeakMap<GPUTexture | GPUTextureView, number>();
	let nextViewId = 1;
	let nextSubmissionId = 1;
	const commandBufferPasses = new WeakMap<GPUCommandBuffer, Omit<GpuRenderPassTrace, 'submissionId'>[]>();
	gpu.requestAdapter = async options => {
		const adapter = await originalRequestAdapter.call(gpu, options);
		if (!adapter) return null;
		const originalRequestDevice = adapter.requestDevice;
		adapter.requestDevice = async descriptor => {
			const device = await originalRequestDevice.call(adapter, descriptor);
			const originalSubmit = device.queue.submit;
			device.queue.submit = commandBuffers => {
				const buffers = [...commandBuffers];
				const submissionId = nextSubmissionId;
				nextSubmissionId += 1;
				for (const commandBuffer of buffers) {
					for (const pass of commandBufferPasses.get(commandBuffer) ?? []) {
						passes.push(Object.freeze({ ...pass, submissionId }));
					}
				}
				originalSubmit.call(device.queue, buffers);
			};
			const originalCreateCommandEncoder = device.createCommandEncoder;
			device.createCommandEncoder = descriptor => {
				const encoder = originalCreateCommandEncoder.call(device, descriptor);
				const encodedPasses: Omit<GpuRenderPassTrace, 'submissionId'>[] = [];
				const originalBeginRenderPass = encoder.beginRenderPass;
				encoder.beginRenderPass = descriptor => {
					const label = descriptor.label ?? '';
					if (label === 'Ash rectangle pass' || label === 'Stanza ViewLinesGpu pass') {
						const attachment = [...descriptor.colorAttachments][0];
						if (attachment) {
							let viewId = viewIds.get(attachment.view);
							if (viewId === undefined) {
								viewId = nextViewId;
								nextViewId += 1;
								viewIds.set(attachment.view, viewId);
							}
							encodedPasses.push(Object.freeze({ label, loadOp: attachment.loadOp, viewId }));
						}
					}
					return originalBeginRenderPass.call(encoder, descriptor);
				};
				const originalFinish = encoder.finish;
				encoder.finish = descriptor => {
					const commandBuffer = originalFinish.call(encoder, descriptor);
					commandBufferPasses.set(commandBuffer, encodedPasses);
					return commandBuffer;
				};
				return encoder;
			};
			return device;
		};
		return adapter;
	};
	return {
		reset: () => {
			passes = [];
			viewIds = new WeakMap();
			nextViewId = 1;
			nextSubmissionId = 1;
		},
		read: () => Object.freeze([...passes]),
		dispose: () => {
			gpu.requestAdapter = originalRequestAdapter;
		},
	};
}

function requiredElement(id: string): HTMLElement {
	const element = document.getElementById(id);
	if (!(element instanceof HTMLElement)) throw new Error(`Missing GPU integration element '#${id}'`);
	return element;
}
