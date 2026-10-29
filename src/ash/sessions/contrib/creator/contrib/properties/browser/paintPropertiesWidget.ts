import { defaultButtonStyles } from '../../../../../../platform/theme/browser/defaultStyles.js';
import { designBlendLabel as blendLabel } from '../../../browser/designPaintLabels.js';
import { addDisposableListener, h } from '../../../../../../base/browser/dom.js';
import { Button } from '../../../../../../base/browser/ui/button/button.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../../../base/common/uuid.js';
import { localize } from '../../../../../../nls.js';
import type { DesignDocumentController } from '../../../browser/designDocumentController.js';
import type { DocumentCommands } from '../../../common/commands/documentCommands.js';
import { createDesignPaint, designBlendModes, designPaints, sampleDesignPaint, type DesignBlendMode, type DesignPaint } from '../../../common/model/designPaint.js';
import { flattenDesignShapes } from '../../../common/model/document.js';
import type { DesignSelection } from '../../../common/selection.js';

export class PaintPropertiesWidget extends Disposable {
	public readonly domNode: HTMLElement;
	private readonly updates: (() => void)[] = [];
	constructor(
		private readonly controller: DesignDocumentController,
		private readonly commands: DocumentCommands,
		private readonly selection: DesignSelection,
		document: Document,
		private readonly refresh: () => void,
		private readonly focusCanvas: () => void,
	) {
		super();
		this.domNode = h(document, 'div', { className: 'ash-design-property-fields ash-design-property-wide' });
		const select = (label: string, options: readonly (readonly [string, string])[], value: () => string, change: (value: string) => void, visible = () => true, enabled = () => true) => {
			const input = h(document, 'select', { attributes: { 'aria-label': label } });
			const row = h(document, 'label', { className: 'ash-design-property-wide' }, label, input);
			this.domNode.append(row);
			input.append(...options.map(([value, text]) => h(document, 'option', { properties: { value } }, text)));
			this._register(
				addDisposableListener(input, 'change', () => {
					if (this.editable && enabled()) {
						change(input.value);
						this.refresh();
					}
				}),
			);
			this.updates.push(() => {
				row.hidden = !visible();
				input.disabled = !this.editable || !enabled();
				input.value = value();
			});
			return input;
		};
		const number = (label: string, value: () => number | undefined, change: (value: number) => void, visible = () => true, min = 0, max = 100) => {
			const input = h(document, 'input', {
				properties: { type: 'number', min: String(min), max: String(max), step: 'any' },
				attributes: { 'aria-label': label },
			});
			const row = h(document, 'label', { className: 'ash-design-property-wide' }, label, input);
			this.domNode.append(row);
			const commit = () => {
				if (this.editable && input.checkValidity() && Number.isFinite(input.valueAsNumber)) {
					change(input.valueAsNumber);
					this.refresh();
				} else {
					input.reportValidity();
				}
			};
			this._register(addDisposableListener(input, 'change', commit));
			this._register(
				addDisposableListener(input, 'keydown', event => {
					if (event.key === 'Enter') {
						commit();
						event.preventDefault();
					}
				}),
			);
			this.updates.push(() => {
				row.hidden = !visible();
				input.disabled = !this.editable;
				if (document.activeElement !== input) {
					const next = value();
					input.value = next === undefined ? '' : String(Math.round(next * 10000) / 10000);
				}
			});
		};
		const action = (label: string, run: () => void, enabled: () => boolean, pressed?: () => boolean, visible = () => this.canFill) => {
			const button = this._register(
				new Button(this.domNode, {
					...defaultButtonStyles,
					label,
					ariaLabel: label,
					onClick: () => {
						if (this.editable && enabled()) {
							run();
							this.refresh();
						}
					},
				}),
			);
			this.updates.push(() => {
				button.domNode.hidden = !visible();
				button.enabled = this.editable && enabled();
				if (pressed) {
					button.domNode.setAttribute('aria-pressed', String(pressed()));
				}
			});
		};
		select(
			localize('sessions.design.layerBlend', 'Layer blend mode'),
			[['pass-through', blendLabel('pass-through')], ...designBlendModes.map(mode => [mode, blendLabel(mode)] as const)],
			() => this.shape?.blendMode ?? 'pass-through',
			value => {
				const shape = this.shape;
				if (shape) {
					this.commands.updateShape({ ...shape, blendMode: value as DesignBlendMode | 'pass-through' });
				}
			},
		);
		number(
			localize('sessions.design.layerOpacityPercent', 'Layer opacity (%)'),
			() => (this.shape?.opacity ?? 1) * 100,
			value => {
				if (this.shape) {
					this.commands.updateShape({ ...this.shape, opacity: value / 100 });
				}
			},
		);
		const paints = select(
			localize('sessions.design.paintLayer', 'Fill layer'),
			[],
			() => this.paint?.id ?? '',
			value => {
				this.selection.paintId = value;
				this.selection.gradientStopId = undefined;
			},
			() => this.canFill,
		);
		this.updates.push(() => {
			paints.replaceChildren(
				...this.paints.map((paint, index) =>
					h(document, 'option', { properties: { value: paint.id } }, localize('sessions.design.paintLayerName', '{0}: {1}', index + 1, this.typeLabel(paint.type))),
				),
			);
			paints.value = this.paint?.id ?? '';
		});
		action(
			localize('sessions.design.paintAdd', 'Add fill'),
			() => {
				const paint = { ...createDesignPaint('solid', '#000000'), opacity: 0.2 };
				this.setPaints([paint, ...this.paints]);
				this.selection.paintId = paint.id;
			},
			() => this.canFill && this.paints.length < 64,
		);
		action(
			localize('sessions.design.paintDuplicate', 'Duplicate fill'),
			() => {
				const paint = this.paint!;
				const copy = {
					...paint,
					id: generateUuid(),
					...(paint.type !== 'solid' ? { stops: paint.stops.map(stop => ({ ...stop, id: generateUuid() })) } : {}),
				};
				const values = this.paints.slice();
				values.splice(values.indexOf(paint), 0, copy);
				this.setPaints(values);
				this.selection.paintId = copy.id;
			},
			() => this.canFill && !!this.paint && this.paints.length < 64,
		);
		action(
			localize('sessions.design.paintRemove', 'Remove fill'),
			() => {
				this.setPaints(this.paints.filter(paint => paint.id !== this.paint?.id));
				this.selection.paintId = undefined;
			},
			() => this.canFill && !!this.paint,
		);
		for (const [direction, label] of [
			[-1, localize('sessions.design.paintUp', 'Move fill up')],
			[1, localize('sessions.design.paintDown', 'Move fill down')],
		] as const) {
			action(
				label,
				() => {
					const paints = this.paints.slice(),
						index = paints.indexOf(this.paint!);
					[paints[index], paints[index + direction]] = [paints[index + direction], paints[index]];
					this.setPaints(paints);
				},
				() => this.canFill && !!this.paint && this.paints.indexOf(this.paint) + direction >= 0 && this.paints.indexOf(this.paint) + direction < this.paints.length,
			);
		}
		const visibleLabel = localize('sessions.design.paintVisible', 'Fill visible');
		const visible = h(document, 'input', {
			properties: { type: 'checkbox' },
			attributes: { 'aria-label': visibleLabel },
		});
		const visibility = h(document, 'label', { className: 'ash-design-property-wide' }, visible, visibleLabel);
		this.domNode.append(visibility);
		this._register(
			addDisposableListener(visible, 'change', () => {
				if (this.editable && this.paint) {
					this.edit({ ...this.paint, visible: visible.checked });
					this.refresh();
				}
			}),
		);
		this.updates.push(() => {
			visibility.hidden = !this.canFill || !this.paint;
			visible.disabled = !this.editable;
			visible.checked = this.paint?.visible !== false;
		});
		select(
			localize('sessions.design.paintType', 'Fill type'),
			(['solid', 'linear', 'radial', 'angular', 'diamond'] as const).map(type => [type, this.typeLabel(type)]),
			() => this.paint?.type ?? 'solid',
			value => {
				const paint = this.paint;
				if (!paint) {
					return;
				}
				const next = createDesignPaint(value as DesignPaint['type'], paint.type === 'solid' ? paint.color : paint.stops[0].color);
				this.edit({
					...next,
					id: paint.id,
					...(paint.opacity !== undefined ? { opacity: paint.opacity } : {}),
					...(paint.visible !== undefined ? { visible: paint.visible } : {}),
					...(paint.blendMode !== undefined ? { blendMode: paint.blendMode } : {}),
					...(next.type !== 'solid' && paint.type !== 'solid' ? { stops: paint.stops, handles: paint.handles } : {}),
				});
				this.selection.editingGradient = next.type !== 'solid';
				this.selection.editingBlur = false;
				this.selection.gradientStopId = undefined;
			},
			() => this.canFill && !!this.paint,
		);
		number(
			localize('sessions.design.paintOpacity', 'Paint opacity (%)'),
			() => (this.paint?.opacity ?? 1) * 100,
			value => {
				if (this.paint) {
					this.edit({ ...this.paint, opacity: value / 100 });
				}
			},
			() => this.canFill && !!this.paint,
		);
		select(
			localize('sessions.design.paintBlend', 'Fill blend mode'),
			designBlendModes.map(mode => [mode, blendLabel(mode)]),
			() => this.paint?.blendMode ?? 'normal',
			value => {
				if (this.paint) {
					this.edit({ ...this.paint, blendMode: value as DesignBlendMode });
				}
			},
			() => this.canFill && !!this.paint,
			() => !this.shape?.styleBindings?.fill,
		);
		const stops = select(
			localize('sessions.design.gradientStop', 'Gradient stop'),
			[],
			() => this.stop?.id ?? '',
			value => {
				this.selection.gradientStopId = value;
			},
			() => !!this.gradient,
		);
		this.updates.push(() => {
			stops.replaceChildren(
				...(this.gradient?.stops ?? []).map((stop, index) =>
					h(document, 'option', { properties: { value: stop.id } }, localize('sessions.design.gradientStopName', '{0}: {1}%', index + 1, Math.round(stop.position * 10000) / 100)),
				),
			);
			stops.value = this.stop?.id ?? '';
		});
		number(
			localize('sessions.design.gradientStopPosition', 'Gradient stop position (%)'),
			() => (this.stop ? this.stop.position * 100 : undefined),
			value => {
				if (this.gradient && this.stop) {
					this.edit({
						...this.gradient,
						stops: this.gradient.stops.map(stop => (stop.id === this.stop!.id ? { ...stop, position: value / 100 } : stop)).sort((a, b) => a.position - b.position),
					});
				}
			},
			() => !!this.gradient,
		);
		action(
			localize('sessions.design.gradientStopAdd', 'Add gradient stop'),
			() => {
				const paint = this.gradient!;
				const position = Math.min(1, (this.stop?.position ?? 0) + 0.1);
				const color =
					'#' +
					sampleDesignPaint(paint, position)
						.map(value => Math.round(value).toString(16).padStart(2, '0'))
						.join('');
				const stop = { id: generateUuid(), position, color };
				this.edit({ ...paint, stops: [...paint.stops, stop].sort((a, b) => a.position - b.position) });
				this.selection.gradientStopId = stop.id;
			},
			() => !!this.gradient && this.gradient.stops.length < 256,
			undefined,
			() => !!this.gradient,
		);
		action(
			localize('sessions.design.gradientStopRemove', 'Remove gradient stop'),
			() => {
				this.edit({ ...this.gradient!, stops: this.gradient!.stops.filter(stop => stop.id !== this.stop?.id) });
				this.selection.gradientStopId = undefined;
			},
			() => !!this.gradient && this.gradient.stops.length > 2,
			undefined,
			() => !!this.gradient,
		);
		action(
			localize('sessions.design.gradientReverse', 'Reverse gradient'),
			() => {
				this.edit({
					...this.gradient!,
					stops: this.gradient!.stops.map(stop => ({ ...stop, position: 1 - stop.position })).reverse(),
				});
			},
			() => !!this.gradient,
			undefined,
			() => !!this.gradient,
		);
		for (const [index, labels] of [
			[0, [localize('sessions.design.gradientStartX', 'Gradient start X (%)'), localize('sessions.design.gradientStartY', 'Gradient start Y (%)')]],
			[1, [localize('sessions.design.gradientEndX', 'Gradient end X (%)'), localize('sessions.design.gradientEndY', 'Gradient end Y (%)')]],
			[2, [localize('sessions.design.gradientAxisX', 'Gradient axis X (%)'), localize('sessions.design.gradientAxisY', 'Gradient axis Y (%)')]],
		] as const) {
			for (const [axis, label] of [
				['x', labels[0]],
				['y', labels[1]],
			] as const) {
				number(
					label,
					() => (this.gradient ? this.gradient.handles[index][axis] * 100 : undefined),
					value => {
						const paint = this.gradient;
						if (!paint) {
							return;
						}
						const handles = paint.handles.map((point, i) => (i === index ? { ...point, [axis]: value / 100 } : point)) as unknown as typeof paint.handles;
						const [a, b, c] = handles;
						if (Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) >= 1e-8) {
							this.edit({ ...paint, handles });
						}
					},
					() => !!this.gradient,
					-1000000,
					1000000,
				);
			}
		}
		action(
			localize('sessions.design.gradientEdit', 'Edit gradient on canvas'),
			() => {
				this.selection.editingGradient = !this.selection.editingGradient;
				this.selection.editingBlur = false;
				this.selection.paintId = this.paint?.id;
				this.selection.editingVector = this.selection.editingWidth = false;
				this.focusCanvas();
			},
			() => !!this.gradient,
			() => this.selection.editingGradient,
			() => !!this.gradient,
		);
	}
	private typeLabel(type: DesignPaint['type']): string {
		return {
			solid: localize('sessions.design.paintSolid', 'Solid'),
			linear: localize('sessions.design.paintLinear', 'Linear gradient'),
			radial: localize('sessions.design.paintRadial', 'Radial gradient'),
			angular: localize('sessions.design.paintAngular', 'Angular gradient'),
			diamond: localize('sessions.design.paintDiamond', 'Diamond gradient'),
		}[type];
	}
	private get shape() {
		return this.selection.ids.size === 1 ? flattenDesignShapes(this.controller.model.value.shapes).find(shape => this.selection.ids.has(shape.id)) : undefined;
	}
	private get editable(): boolean {
		return !!this.shape && !this.controller.isBusy && !this.commands.components.isInstanceChild(this.shape.id);
	}
	private get canFill(): boolean {
		return !!this.shape && (this.shape.kind !== 'group' || !!this.shape.booleanOperation) && this.shape.kind !== 'image';
	}
	private get paints(): readonly DesignPaint[] {
		return this.shape ? designPaints(this.shape) : [];
	}
	public get paint(): DesignPaint | undefined {
		return this.paints.find(paint => paint.id === this.selection.paintId) ?? this.paints[0];
	}
	private get gradient() {
		const paint = this.paint;
		return paint?.type === 'solid' ? undefined : paint;
	}
	private get stop() {
		return this.gradient?.stops.find(stop => stop.id === this.selection.gradientStopId) ?? this.gradient?.stops[0];
	}
	public get color(): string {
		return this.paint?.type === 'solid' ? this.paint.color : (this.stop?.color ?? this.shape?.fill ?? '#808080');
	}
	private setPaints(fills: readonly DesignPaint[]): void {
		const shape = this.shape;
		if (shape) {
			this.commands.updateShape({ ...shape, fills });
		}
	}
	private edit(paint: DesignPaint): void {
		this.setPaints(this.paints.map(value => (value.id === paint.id ? paint : value)));
	}
	public update(): void {
		if (!this.gradient) {
			this.selection.editingGradient = false;
		}
		for (const update of this.updates) {
			update();
		}
	}
}
