import { prototypeScrollTargets, prototypeShapeEntries } from '../../../common/model/prototypeScroll.js';
import { addDisposableListener, svg } from '../../../../../../base/browser/dom.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { toDesignLocal, type DesignPoint } from '../../../common/core/geometry.js';
import {
	flattenPrototypeActions,
	prototypeFrames,
	prototypeScrollScope,
	prototypeVariants,
} from '../../../common/model/prototype.js';
import type { DesignEditorContributionContext } from '../../../browser/designEditorBrowser.js';

/** The canvas retains its coordinate system; this contribution only owns connection marks and its drag. */
export class PrototypeConnections extends Disposable {
	private readonly marks: SVGGElement;
	private start: DesignPoint | undefined;
	private pointer: number | undefined;
	private draggedIds: ReadonlySet<string> = new Set();
	private scale = 1;
	private enabled = false;
	private end: DesignPoint | undefined;
	constructor(
		private readonly context: DesignEditorContributionContext,
		private readonly focusProperties: (interactionId?: string) => void,
	) {
		super();
		this.marks = svg(context.ownerDocument, 'g', { className: 'ash-prototype-connections' });
		context.overlayDomNode.append(this.marks);
		this._register(
			addDisposableListener(this.marks, 'pointerdown', event => {
				const wire = (event.target as Element).closest<SVGElement>('[data-prototype-interaction]');
				if (wire && !context.documentController.isBusy) {
					event.preventDefault();
					event.stopPropagation();
					const id = wire.dataset.prototypeSource!;
					const interaction = wire.dataset.prototypeInteraction!;
					context.selectShape(id);
					this.focusProperties(interaction);
					return;
				}
				const handle = (event.target as Element).closest('[data-prototype-handle]');
				if (!handle || event.button !== 0 || !this.enabled || context.documentController.isBusy) {
					return;
				}
				event.preventDefault();
				event.stopPropagation();
				this.pointer = event.pointerId;
				this.draggedIds = new Set(context.selection.ids);
				this.start = { x: Number(handle.getAttribute('cx')), y: Number(handle.getAttribute('cy')) };
				this.end = this.start;
				context.canvasDomNode.setPointerCapture?.(event.pointerId);
			}),
		);
		this._register(
			addDisposableListener(
				context.canvasDomNode,
				'pointermove',
				event => {
					if (event.pointerId !== this.pointer) {
						return;
					}
					event.preventDefault();
					event.stopImmediatePropagation();
					this.end = context.toDesignPoint(event);
					this.render();
				},
				true,
			),
		);
		this._register(
			addDisposableListener(
				context.canvasDomNode,
				'pointerup',
				event => {
					if (event.pointerId !== this.pointer) {
						return;
					}
					event.preventDefault();
					event.stopImmediatePropagation();
					const point = context.toDesignPoint(event);
					const entries = prototypeShapeEntries(context.documentController.model.value.shapes);
					const target = [...entries].reverse().find(entry => {
						const frame = entry.world;
						const eligible =
							[...this.draggedIds].some(id =>
								prototypeScrollTargets(context.documentController.model.value.shapes, id, false).some(
									target => target.id === entry.shape.id,
								),
							) ||
							(frame.kind === 'frame' &&
								(frame.component?.kind === 'main' || (!entry.ancestors.length && !frame.component)));
						const local = toDesignLocal(frame, point);
						return (
							eligible &&
							entry.ancestors.every(ancestor => {
								if (ancestor.visible === false) {
									return false;
								}
								if (ancestor.kind !== 'frame' || !ancestor.clip) {
									return true;
								}
								const bounds = entries.find(item => item.shape.id === ancestor.id)!.world,
									pointInParent = toDesignLocal(bounds, point);
								return (
									pointInParent.x >= 0 &&
									pointInParent.y >= 0 &&
									pointInParent.x <= bounds.width &&
									pointInParent.y <= bounds.height
								);
							}) &&
							frame.visible !== false &&
							local.x >= 0 &&
							local.y >= 0 &&
							local.x <= frame.width &&
							local.y <= frame.height
						);
					});
					const ids = this.draggedIds;
					this.cancel();
					if (target && !context.documentController.isBusy) {
						context.commands.prototype.connect(ids, target.shape.id);
						this.focusProperties();
					}
				},
				true,
			),
		);
		this._register(addDisposableListener(context.canvasDomNode, 'pointercancel', () => this.cancel()));
		this._register(addDisposableListener(context.canvasDomNode, 'lostpointercapture', () => this.cancel()));
		this._register(
			addDisposableListener(
				context.ownerDocument,
				'keydown',
				event => {
					if (this.pointer !== undefined && event.key === 'Escape') {
						event.preventDefault();
						event.stopImmediatePropagation();
						this.cancel();
					}
				},
				true,
			),
		);
		this._register(context.documentController.model.onDidChange(() => this.cancel()));
	}
	public update(scale: number, enabled: boolean): void {
		this.scale = scale;
		this.enabled = enabled;
		if (!enabled) {
			this.cancel();
		}
		this.render();
	}
	public cancel(): void {
		const pointer = this.pointer;
		this.pointer = undefined;
		this.start = undefined;
		this.end = undefined;
		if (pointer !== undefined && this.context.canvasDomNode.hasPointerCapture?.(pointer)) {
			this.context.canvasDomNode.releasePointerCapture(pointer);
		}
		this.render();
	}
	private render(): void {
		this.marks.replaceChildren();
		if (!this.enabled) {
			return;
		}
		const shapes = this.context.documentController.model.value.shapes;
		const frames = prototypeFrames(shapes);
		const entries = prototypeShapeEntries(shapes);
		const ownerDocument = this.context.ownerDocument;
		const wire = (from: DesignPoint, to: DesignPoint, source?: string, interaction?: string): void => {
			const bend = Math.max(48 / this.scale, Math.abs(to.x - from.x) / 2);
			this.marks.append(
				svg(ownerDocument, 'path', {
					className: source ? 'ash-prototype-wire' : '',
					attributes: {
						...(source
							? { 'data-prototype-source': source, 'data-prototype-interaction': interaction! }
							: {}),
						d: `M ${from.x} ${from.y} C ${from.x + bend} ${from.y}, ${to.x - bend} ${to.y}, ${to.x} ${to.y}`,
					},
				}),
			);
			this.marks.append(
				svg(ownerDocument, 'path', {
					attributes: {
						d: `M ${to.x - 6 / this.scale} ${to.y - 4 / this.scale} L ${to.x} ${to.y} L ${to.x - 6 / this.scale} ${to.y + 4 / this.scale}`,
					},
				}),
			);
		};
		for (const { shape, world } of entries) {
			if (shape.visible === false) {
				continue;
			}
			const angle = (world.rotation * Math.PI) / 180;
			const from = {
				x: world.x + world.width / 2 + (world.width / 2) * Math.cos(angle),
				y: world.y + world.height / 2 + (world.width / 2) * Math.sin(angle),
			};
			for (const interaction of shape.interactions ?? []) {
				for (const action of flattenPrototypeActions(interaction.actions)) {
					const target =
						action.action === 'changeTo' || action.action === 'scrollTo'
							? entries.find(entry => entry.shape.id === action.destination)?.world
							: frames.find(frame => frame.id === action.destination);
					if (target) {
						wire(from, { x: target.x, y: target.y + target.height / 2 }, shape.id, interaction.id);
					}
				}
			}
			if (
				this.context.selection.ids.has(shape.id) &&
				(prototypeScrollScope(shapes, shape.id) || prototypeVariants(shapes, shape.id).length)
			) {
				this.marks.append(
					svg(ownerDocument, 'circle', {
						className: 'ash-prototype-handle',
						attributes: {
							'data-prototype-handle': shape.id,
							cx: `${from.x}`,
							cy: `${from.y}`,
							r: `${6 / this.scale}`,
						},
					}),
				);
			}
			if (shape.flowStart) {
				const label = svg(ownerDocument, 'text', {
					attributes: {
						x: `${world.x}`,
						y: `${world.y - 12 / this.scale}`,
						'font-size': `${12 / this.scale}`,
					},
				});
				label.textContent = shape.flowStart;
				this.marks.append(label);
			}
		}
		if (this.start && this.end) {
			wire(this.start, this.end);
		}
	}
	public override dispose(): void {
		this.cancel();
		this.marks.remove();
		super.dispose();
	}
}
