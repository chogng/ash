import { MutableDisposable, toDisposable, type IReference } from '../../../base/common/lifecycle.js';
import { type IObservable } from '../../../base/common/observable.js';
import { ViewEventHandler } from '../../common/viewEventHandler.js';
import { type ViewScrollChangedEvent } from '../../common/viewEvents.js';
import { type ViewportData } from '../../common/viewLayout/viewLinesViewportData.js';
import { type ViewContext } from '../../common/viewModel/viewContext.js';
import { GPULifecycle } from './gpuDisposable.js';
import { quadVertices } from './gpuUtils.js';
import { createObjectCollectionBuffer, type IObjectCollectionBuffer, type IObjectCollectionBufferEntry } from './objectCollectionBuffer.js';
import { RectangleRendererBindingId, rectangleRendererWgsl } from './rectangleRenderer.wgsl.js';

export type RectangleRendererEntrySpec = [
	{ name: 'x' }, { name: 'y' }, { name: 'width' }, { name: 'height' },
	{ name: 'red' }, { name: 'green' }, { name: 'blue' }, { name: 'alpha' },
];

const rectangleProperties: RectangleRendererEntrySpec = [
	{ name: 'x' }, { name: 'y' }, { name: 'width' }, { name: 'height' },
	{ name: 'red' }, { name: 'green' }, { name: 'blue' }, { name: 'alpha' },
];

export class RectangleRenderer extends ViewEventHandler {
	private readonly shapes: IObjectCollectionBuffer<RectangleRendererEntrySpec> = this._register(createObjectCollectionBuffer(rectangleProperties, 32));
	private readonly shapeBuffer = this._register(new MutableDisposable<IReference<GPUBuffer>>());
	private readonly vertexBuffer = this._register(new MutableDisposable<IReference<GPUBuffer>>());
	private readonly layoutBuffer = this._register(new MutableDisposable<IReference<GPUBuffer>>());
	private readonly scrollBuffer = this._register(new MutableDisposable<IReference<GPUBuffer>>());
	private device: GPUDevice | undefined;
	private pipeline: GPURenderPipeline | undefined;
	private bindGroup: GPUBindGroup | undefined;

	constructor(
		private readonly context: ViewContext,
		private readonly contentLeft: IObservable<number>,
		private readonly devicePixelRatio: IObservable<number>,
		private readonly canvas: HTMLCanvasElement,
		private readonly ctx: GPUCanvasContext,
		device: Promise<GPUDevice>,
	) {
		super();
		this.context.addEventHandler(this);
		this._register(toDisposable(() => this.context.removeEventHandler(this)));
		this._register(this.shapes.onDidChangeBuffer(() => {
			if (!this.device || !this.pipeline) return;
			this.createShapeBuffer();
			this.bindGroup = this.createBindGroup();
		}));
		void this.initialize(device);
	}

	public register(x: number, y: number, width: number, height: number, red: number, green: number, blue: number, alpha: number): IObjectCollectionBufferEntry<RectangleRendererEntrySpec> {
		return this.shapes.createEntry({ x, y, width, height, red, green, blue, alpha });
	}

	public override onScrollChanged(event: ViewScrollChangedEvent): boolean {
		return event.scrollLeftChanged || event.scrollTopChanged;
	}

	public draw(viewportData: ViewportData): void {
		const device = this.device;
		const pipeline = this.pipeline;
		const bindGroup = this.bindGroup;
		if (!device || !pipeline || !bindGroup || !this.vertexBuffer.value || !this.layoutBuffer.value || !this.scrollBuffer.value) return;
		this.updateShapeBuffer();
		const width = this.canvas.width;
		const height = this.canvas.height;
		const devicePixelRatio = this.devicePixelRatio.get();
		const contentLeft = Math.min(width, Math.max(0, Math.ceil(this.contentLeft.get() * devicePixelRatio)));
		device.queue.writeBuffer(this.layoutBuffer.value.object, 0, new Float32Array([
			width,
			height,
			contentLeft,
			0,
			Math.max(0, width - contentLeft),
			height,
		]));
		device.queue.writeBuffer(this.scrollBuffer.value.object, 0, new Float32Array([
			this.context.viewLayout.getCurrentScrollLeft() * devicePixelRatio,
			(this.context.viewLayout.getCurrentScrollTop() - viewportData.bigNumbersDelta) * devicePixelRatio,
		]));
		const encoder = device.createCommandEncoder({ label: 'Ash rectangle frame' });
		const pass = encoder.beginRenderPass({
			label: 'Ash rectangle pass',
			colorAttachments: [{
				view: this.ctx.getCurrentTexture().createView(),
				clearValue: { r: 0, g: 0, b: 0, a: 0 },
				loadOp: 'clear',
				storeOp: 'store',
			}],
		});
		if (this.shapes.entryCount > 0 && contentLeft < width && height > 0) {
			pass.setPipeline(pipeline);
			pass.setVertexBuffer(0, this.vertexBuffer.value.object);
			pass.setBindGroup(0, bindGroup);
			pass.setScissorRect(contentLeft, 0, width - contentLeft, height);
			pass.draw(quadVertices.length / 2, this.shapes.entryCount);
		}
		pass.end();
		device.queue.submit([encoder.finish()]);
	}

	private async initialize(device: Promise<GPUDevice>): Promise<void> {
		const resolvedDevice = await device;
		if (this.isDisposed) return;
		this.device = resolvedDevice;
		const presentationFormat = this.canvas.ownerDocument.defaultView!.navigator.gpu.getPreferredCanvasFormat();
		this.ctx.configure({ device: resolvedDevice, format: presentationFormat, alphaMode: 'premultiplied' });
		this.vertexBuffer.value = GPULifecycle.createBuffer(resolvedDevice, {
			label: 'Ash rectangle vertices',
			size: quadVertices.byteLength,
			usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
		}, quadVertices as Float32Array<ArrayBuffer>);
		this.layoutBuffer.value = GPULifecycle.createBuffer(resolvedDevice, {
			label: 'Ash rectangle layout',
			size: 6 * Float32Array.BYTES_PER_ELEMENT,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});
		this.scrollBuffer.value = GPULifecycle.createBuffer(resolvedDevice, {
			label: 'Ash rectangle scroll offset',
			size: 2 * Float32Array.BYTES_PER_ELEMENT,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});
		const module = resolvedDevice.createShaderModule({ label: 'Ash rectangle shader', code: rectangleRendererWgsl });
		this.pipeline = resolvedDevice.createRenderPipeline({
			label: 'Ash rectangle pipeline',
			layout: 'auto',
			vertex: {
				module,
				entryPoint: 'vs',
				buffers: [{
					arrayStride: 2 * Float32Array.BYTES_PER_ELEMENT,
					attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }],
				}],
			},
			fragment: {
				module,
				entryPoint: 'fs',
				targets: [{
					format: presentationFormat,
					blend: {
						color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
						alpha: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
					},
				}],
			},
		});
		this.createShapeBuffer();
		this.bindGroup = this.createBindGroup();
	}

	private createShapeBuffer(): void {
		const device = this.device!;
		this.shapeBuffer.value = GPULifecycle.createBuffer(device, {
			label: 'Ash rectangle shapes',
			size: this.shapes.buffer.byteLength,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
		});
		if (this.shapes.viewUsedSize > 0) {
			device.queue.writeBuffer(this.shapeBuffer.value.object, 0, this.shapes.view as Float32Array<ArrayBuffer>, 0, this.shapes.viewUsedSize);
		}
		this.shapes.dirtyTracker.clear();
	}

	private createBindGroup(): GPUBindGroup {
		return this.device!.createBindGroup({
			label: 'Ash rectangle bindings',
			layout: this.pipeline!.getBindGroupLayout(0),
			entries: [
				{ binding: RectangleRendererBindingId.Shapes, resource: { buffer: this.shapeBuffer.value!.object } },
				{ binding: RectangleRendererBindingId.LayoutInfoUniform, resource: { buffer: this.layoutBuffer.value!.object } },
				{ binding: RectangleRendererBindingId.ScrollOffset, resource: { buffer: this.scrollBuffer.value!.object } },
			],
		});
	}

	private updateShapeBuffer(): void {
		const dirty = this.shapes.dirtyTracker;
		if (!dirty.isDirty || dirty.dataOffset === undefined || dirty.dirtySize === undefined || !this.shapeBuffer.value) return;
		this.device!.queue.writeBuffer(
			this.shapeBuffer.value.object,
			dirty.dataOffset * Float32Array.BYTES_PER_ELEMENT,
			this.shapes.view as Float32Array<ArrayBuffer>,
			dirty.dataOffset,
			dirty.dirtySize,
		);
		dirty.clear();
	}
}
