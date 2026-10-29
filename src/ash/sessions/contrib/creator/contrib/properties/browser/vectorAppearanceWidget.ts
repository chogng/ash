import { designPathEndpoints } from '../../../common/model/designVectorStroke.js';
import { addDisposableListener, h } from '../../../../../../base/browser/dom.js';
import type { IAction } from '../../../../../../base/common/actions.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../../../base/common/uuid.js';
import { localize } from '../../../../../../nls.js';
import type { DesignDocumentController } from '../../../browser/designDocumentController.js';
import { loadDesignVectorGeometry, offsetDesignVector } from '../../../browser/designVectorGeometry.js';
import type { DocumentCommands } from '../../../common/commands/documentCommands.js';
import { flattenDesignVector } from '../../../common/commands/vectorCommands.js';
import { flattenDesignShapes, type DesignWidthPoint, type DesignEndpoint } from '../../../common/model/document.js';
import { designPathEditingContours, designPathStrokeContours, fitDesignPathBounds, isDesignVector, withDesignPathContours, type DesignPath } from '../../../common/model/designVector.js';
import { designWidthPointAt, supportsDesignVariableWidth } from '../../../common/model/designVariableWidth.js';
import { withDesignVectorNetwork } from '../../../common/model/designVectorNetwork.js';
import type { DesignSelection } from '../../../common/selection.js';

/** Appearance values belong to the document. Offset previews belong to this view until confirmation. */
export class VectorAppearanceWidget extends Disposable {
	public readonly domNode: HTMLElement;
	private readonly updates: (() => void)[] = [];
	private readonly message: HTMLElement;
	private running = false;
	private offset: { source: DesignPath; version: string; result: DesignPath; amount: number; join: 'miter' | 'round' } | undefined;
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
		const number = (label: string, value: () => number | undefined, change: (value: number) => void, available: () => boolean, min = 0, max?: number) => {
			const input = h(document, 'input', {
				properties: {
					type: 'number',
					step: 'any',
					min: String(min),
					...(max !== undefined ? { max: String(max) } : {}),
				},
				attributes: { 'aria-label': label },
			});
			const row = h(document, 'label', { className: 'ash-design-property-wide' }, label, input);
			this.domNode.append(row);
			this._register(
				addDisposableListener(input, 'change', () => {
					if (this.editable && available() && input.checkValidity() && Number.isFinite(input.valueAsNumber)) {
						change(input.valueAsNumber);
						this.refresh();
					} else {
						input.reportValidity();
					}
				}),
			);
			this._register(
				addDisposableListener(input, 'keydown', event => {
					if (!this.editable || !available()) {
						return;
					}
					if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
						const next = (Number.isFinite(input.valueAsNumber) ? input.valueAsNumber : (value() ?? 0)) + (event.key === 'ArrowUp' ? 1 : -1) * (event.shiftKey ? 10 : 1);
						input.value = String(Math.max(min, Math.min(max ?? Infinity, next)));
						change(input.valueAsNumber);
						this.refresh();
						event.preventDefault();
						event.stopPropagation();
					} else if (event.key === 'Enter' && input.checkValidity() && Number.isFinite(input.valueAsNumber)) {
						change(input.valueAsNumber);
						this.refresh();
						event.preventDefault();
					}
				}),
			);
			this.updates.push(() => {
				row.hidden = !available();
				input.disabled = !this.editable;
				if (document.activeElement !== input) {
					const current = value();
					input.value = current === undefined ? '' : String(Math.round(current * 1000) / 1000);
				}
			});
			return input;
		};
		number(
			localize('sessions.design.nodeRadius', 'Node corner radius'),
			() => {
				const nodes = this.path
					? designPathEditingContours(this.path).flatMap((contour, ci) =>
							contour.nodes.filter((_, i) => !this.selection.editingVector || (ci === this.selection.contourIndex && this.selection.nodeIndices.has(i))),
						)
					: [];
				const values = new Set(nodes.map(node => node.cornerRadius ?? 0));
				return values.size === 1 ? [...values][0] : undefined;
			},
			radius => {
				const path = this.path;
				if (!path) {
					return;
				}
				const selected = (ci: number, i: number) => !this.selection.editingVector || (ci === this.selection.contourIndex && this.selection.nodeIndices.has(i));
				if (path.network) {
					this.commands.vector.update(
						withDesignVectorNetwork(path, {
							...path.network,
							vertices: path.network.vertices.map((node, i) => (selected(0, i) ? { ...node, cornerRadius: radius } : node)),
						}),
					);
				} else {
					this.commands.vector.update(
						withDesignPathContours(
							path,
							designPathEditingContours(path).map((contour, ci) => ({
								...contour,
								nodes: contour.nodes.map((node, i) => (selected(ci, i) ? { ...node, cornerRadius: radius } : node)),
							})),
						),
					);
				}
			},
			() => !!this.path && !this.offset,
		);
		number(
			localize('sessions.design.cornerSmoothing', 'Corner smoothing (%)'),
			() => (this.path?.cornerSmoothing ?? 0) * 100,
			value => {
				if (this.path) {
					this.commands.vector.update({ ...this.path, cornerSmoothing: value / 100 });
				}
			},
			() => !!this.path && !this.offset,
			0,
			100,
		);
		const select = (label: string, options: readonly (readonly [string, string])[], value: () => string, change: (value: string) => void, visible: () => boolean, enabled = () => true) => {
			const input = h(document, 'select', { attributes: { 'aria-label': label } }, ...options.map(([value, label]) => h(document, 'option', { properties: { value } }, label)));
			const row = h(document, 'label', { className: 'ash-design-property-wide' }, label, input);
			this.domNode.append(row);
			this._register(
				addDisposableListener(input, 'change', () => {
					if (this.editable && !this.offset && enabled()) {
						change(input.value);
						this.refresh();
					}
				}),
			);
			this.updates.push(() => {
				row.hidden = !visible() || !!this.offset;
				input.disabled = !this.editable || !enabled();
				input.value = value();
			});
		};
		select(
			localize('sessions.design.strokeAlignment', 'Stroke alignment'),
			[
				['center', localize('sessions.design.strokeCenter', 'Center')],
				['inside', localize('sessions.design.strokeInside', 'Inside')],
				['outside', localize('sessions.design.strokeOutside', 'Outside')],
			],
			() => (this.path?.widthPoints?.length ? 'center' : (this.path?.strokeAlignment ?? 'center')),
			value => {
				if (this.path) {
					this.commands.vector.update({
						...this.path,
						strokeAlignment: value as 'center' | 'inside' | 'outside',
					});
				}
			},
			() => !!this.path,
			() => !!this.path && !this.path.widthPoints?.length && designPathStrokeContours(this.path).some(contour => contour.closed),
		);
		const endpointOptions: readonly (readonly [DesignEndpoint, string])[] = [
			['butt', localize('sessions.design.endpointNone', 'None')],
			['round', localize('sessions.design.vectorRound', 'Round')],
			['square', localize('sessions.design.vectorSquare', 'Square')],
			['line-arrow', localize('sessions.design.endpointLine', 'Line arrow')],
			['triangle-arrow', localize('sessions.design.endpointTriangle', 'Triangle arrow')],
			['reverse-triangle', localize('sessions.design.endpointReverse', 'Reverse triangle')],
			['diamond-arrow', localize('sessions.design.endpointDiamond', 'Diamond arrow')],
			['circle-arrow', localize('sessions.design.endpointCircle', 'Circle arrow')],
		];
		const endpoints = () => (this.path ? designPathEndpoints(this.path) : []);
		const selectedEnds = () => endpoints().filter(end => !this.selection.editingVector || (end.contour === this.selection.contourIndex && this.selection.nodeIndices.has(end.index)));
		for (const [index, label] of [
			[0, localize('sessions.design.endpointStart', 'Start endpoint')],
			[1, localize('sessions.design.endpointEnd', 'End endpoint')],
		] as const) {
			select(
				label,
				endpointOptions,
				() => endpoints()[index]?.style ?? 'butt',
				value => {
					if (this.path) {
						this.commands.vector.setEndpoints(this.path, [endpoints()[index]], value as DesignEndpoint);
					}
				},
				() => !this.selection.editingVector && endpoints().length === 2,
			);
		}
		select(
			localize('sessions.design.endpointStyle', 'Endpoint style'),
			endpointOptions,
			() => {
				const styles = new Set(selectedEnds().map(end => end.style));
				return styles.size === 1 ? [...styles][0] : '';
			},
			value => {
				if (this.path) {
					this.commands.vector.setEndpoints(this.path, selectedEnds(), value as DesignEndpoint);
				}
			},
			() => endpoints().length > 0 && (this.selection.editingVector || endpoints().length !== 2),
			() => selectedEnds().length > 0,
		);
		const profileLabel = localize('sessions.design.widthProfile', 'Width profile');
		const profile = h(
			document,
			'select',
			{ attributes: { 'aria-label': profileLabel } },
			...[
				['uniform', localize('sessions.design.widthUniform', 'Uniform')],
				['both', localize('sessions.design.widthTaperBoth', 'Taper both ends')],
				['start', localize('sessions.design.widthTaperStart', 'Taper start')],
				['end', localize('sessions.design.widthTaperEnd', 'Taper end')],
				['custom', localize('sessions.design.widthCustom', 'Custom')],
			].map(([value, label]) => h(document, 'option', { properties: { value, disabled: value === 'custom' } }, label)),
		);
		const profileRow = h(document, 'label', { className: 'ash-design-property-wide' }, profileLabel, profile);
		this.domNode.append(profileRow);
		this._register(
			addDisposableListener(profile, 'change', () => {
				const path = this.path;
				if (!path || !this.editable || !supportsDesignVariableWidth(path)) {
					return;
				}
				const widthPoints =
					profile.value === 'uniform'
						? undefined
						: designPathStrokeContours(path).flatMap((value, contour) =>
								(value.closed ? [0, 0.5] : [0, 0.5, 1]).map(position => ({
									id: generateUuid(),
									contour,
									position,
									width: position === 0.5 || (position === 0 && profile.value === 'end') || (position === 1 && profile.value === 'start') ? 1 : 0,
								})),
							);
				this.commands.vector.update({ ...path, widthPoints });
				this.selection.widthPointIds.clear();
				this.refresh();
			}),
		);
		this.updates.push(() => {
			profileRow.hidden = !this.path || !!this.offset;
			profile.disabled = !this.editable || !this.canWidth;
			profile.value = this.path?.widthPoints?.length ? 'custom' : 'uniform';
		});
		const pointLabel = localize('sessions.design.widthPoint', 'Width point'),
			point = h(document, 'select', { attributes: { 'aria-label': pointLabel } });
		const pointRow = h(document, 'label', { className: 'ash-design-property-wide' }, pointLabel, point);
		this.domNode.append(pointRow);
		this._register(
			addDisposableListener(point, 'change', () => {
				this.selection.selectWidth(point.value);
				this.refresh();
			}),
		);
		this.updates.push(() => {
			pointRow.hidden = !this.path?.widthPoints?.length || !!this.offset;
			point.replaceChildren(...(this.path?.widthPoints ?? []).map((value, i) => h(document, 'option', { properties: { value: value.id } }, String(i + 1))));
			point.value = this.widthPoint?.id ?? '';
			point.disabled = !this.editable;
		});
		number(
			localize('sessions.design.widthPosition', 'Width point position (%)'),
			() => (this.widthPoint ? this.widthPoint.position * 100 : undefined),
			value => this.editWidth({ position: value / 100 }),
			() => !!this.widthPoint && !this.offset,
			0,
			100,
		);
		number(
			localize('sessions.design.widthValue', 'Width at point'),
			() => (this.widthPoint && this.path ? this.widthPoint.width * this.path.strokeWidth : undefined),
			value => {
				if (this.path?.strokeWidth) {
					this.editWidth({ width: value / this.path.strokeWidth });
				}
			},
			() => !!this.widthPoint && !this.offset,
			0,
			10000,
		);
		const amount = number(
			localize('sessions.design.offsetAmount', 'Offset amount'),
			() => this.offset?.amount,
			value => this.previewOffset(value),
			() => !!this.offset,
			-10000,
			10000,
		);
		const joinLabel = localize('sessions.design.offsetJoin', 'Offset join'),
			join = h(
				document,
				'select',
				{ attributes: { 'aria-label': joinLabel } },
				h(document, 'option', { properties: { value: 'miter' } }, localize('sessions.design.vectorSquare', 'Square')),
				h(document, 'option', { properties: { value: 'round' } }, localize('sessions.design.vectorRound', 'Round')),
			);
		const joinRow = h(document, 'label', { className: 'ash-design-property-wide' }, joinLabel, join);
		this.domNode.append(joinRow);
		this._register(
			addDisposableListener(join, 'change', () => {
				if (this.offset) {
					this.previewOffset(this.offset.amount, join.value as 'miter' | 'round');
					this.refresh();
				}
			}),
		);
		for (const input of [amount, join]) {
			this._register(
				addDisposableListener(input, 'keydown', event => {
					if (event.key === 'Escape') {
						this.cancel();
						this.refresh();
						this.focusCanvas();
						event.preventDefault();
						event.stopPropagation();
					} else if (event.key === 'Enter') {
						if (input === amount && amount.checkValidity() && Number.isFinite(amount.valueAsNumber)) {
							this.previewOffset(amount.valueAsNumber);
						}
						this.applyOffset();
						event.preventDefault();
						event.stopPropagation();
					}
				}),
			);
		}
		this.updates.push(() => {
			joinRow.hidden = !this.offset;
			join.value = this.offset?.join ?? 'miter';
			join.disabled = !this.editable;
		});
		this.message = h(document, 'div', {
			className: 'ash-design-property-wide',
			attributes: { role: 'status', 'aria-live': 'polite' },
		});
		this.domNode.append(this.message);
	}
	private get shape() {
		return this.selection.ids.size === 1 ? flattenDesignShapes(this.controller.model.value.shapes).find(shape => this.selection.ids.has(shape.id)) : undefined;
	}
	private get path(): DesignPath | undefined {
		const shape = this.shape;
		return shape?.kind === 'path' ? shape : undefined;
	}
	private get editable(): boolean {
		return !this.running && !this.controller.isBusy && !!this.shape && !this.commands.components.isInstanceChild(this.shape.id);
	}
	private get canWidth(): boolean {
		return !!this.path?.strokeWidth && supportsDesignVariableWidth(this.path);
	}
	private get widthPoint(): DesignWidthPoint | undefined {
		return this.path?.widthPoints?.find(point => this.selection.widthPointIds.has(point.id)) ?? this.path?.widthPoints?.[0];
	}
	private editWidth(edit: Partial<DesignWidthPoint>): void {
		const path = this.path,
			point = this.widthPoint;
		if (!path || !point || !this.canWidth) {
			return;
		}
		this.commands.vector.update({
			...path,
			widthPoints: path.widthPoints!.map(value => (value.id === point.id || this.selection.widthPointIds.has(value.id) ? { ...value, ...edit, slope: 0 } : value)),
		});
	}
	public get preview(): DesignPath | undefined {
		return this.offset?.version === this.controller.model.version && this.shape?.id === this.offset.source.id ? this.offset.result : undefined;
	}
	public cancel(): void {
		this.offset = undefined;
	}
	private previewOffset(amount: number, join = this.offset?.join ?? 'miter'): void {
		const state = this.offset;
		if (!state) {
			return;
		}
		try {
			const contours = amount === 0 ? undefined : offsetDesignVector(state.source, amount, join);
			this.offset = {
				...state,
				amount,
				join,
				result: contours ? fitDesignPathBounds(withDesignPathContours(state.source, contours)) : state.source,
			};
			this.message.textContent = contours?.length === 0 ? localize('sessions.design.offsetEmpty', 'This offset removes the path. Apply to confirm, or cancel to keep it.') : '';
		} catch (error) {
			this.message.textContent = localize('sessions.design.vectorFailed', 'Could not calculate the vector: {0}', String(error));
		}
	}
	private applyOffset(): void {
		const preview = this.preview,
			state = this.offset;
		if (!preview || !state || !this.editable) {
			return;
		}
		this.cancel();
		if (state.amount !== 0) {
			if (!preview.nodes.length && !preview.network) {
				this.commands.removeShapes(new Set([preview.id]));
				this.selection.set([]);
			} else {
				this.commands.vector.update(preview);
				this.selection.selectNode(0, 0);
			}
		}
		this.refresh();
		this.focusCanvas();
	}
	public getActions(): readonly IAction[] {
		const action = (id: string, label: string, enabled: boolean, run: () => unknown): IAction => ({
			id: `sessions.design.${id}`,
			label,
			tooltip: label,
			enabled: this.editable && enabled,
			run: () => {
				const result = run();
				this.refresh();
				this.focusCanvas();
				return result;
			},
		});
		return [
			action('smoothingIos', localize('sessions.design.smoothingIos', 'iOS smoothing (60%)'), !!this.path && !this.offset, () => {
				if (this.path) {
					this.commands.vector.update({ ...this.path, cornerSmoothing: 0.6 });
				}
			}),
			action('variableWidth', localize('sessions.design.variableWidth', 'Variable width tool'), this.canWidth && !this.offset, () => {
				this.selection.editingVector = true;
				this.selection.paintingVector = false;
				this.selection.editingWidth = !this.selection.editingWidth;
			}),
			action('widthAdd', localize('sessions.design.widthAdd', 'Add width point'), this.canWidth && !this.offset && (this.path?.widthPoints?.length ?? 0) < 1000, () => {
				const path = this.path!;
				const point = {
					id: generateUuid(),
					contour: Math.min(this.selection.contourIndex, designPathStrokeContours(path).length - 1),
					position: 0.5,
					...designWidthPointAt(path, Math.min(this.selection.contourIndex, designPathStrokeContours(path).length - 1), 0.5),
				};
				this.commands.vector.update({ ...path, widthPoints: [...(path.widthPoints ?? []), point] });
				this.selection.selectWidth(point.id);
			}),
			action('widthRemove', localize('sessions.design.widthRemove', 'Remove width point'), !!this.widthPoint && !this.offset, () => {
				const id = this.widthPoint!.id;
				this.commands.vector.update({
					...this.path!,
					widthPoints: this.path!.widthPoints!.filter(point => point.id !== id && !this.selection.widthPointIds.has(point.id)),
				});
				this.selection.widthPointIds.clear();
			}),
			action('vectorOffset', localize('sessions.design.vectorOffset', 'Offset vector'), !!this.shape && isDesignVector(this.shape) && !this.offset, async () => {
				const shape = this.shape!,
					version = this.controller.model.version;
				this.running = true;
				this.refresh();
				try {
					await loadDesignVectorGeometry();
					if (this.isDisposed || version !== this.controller.model.version || this.shape?.id !== shape.id) {
						return;
					}
					const source = shape.kind === 'path' ? shape : flattenDesignVector(shape, offsetDesignVector(shape, 0, 'miter'));
					this.offset = { source, result: source, version, amount: 0, join: 'miter' };
					this.selection.editingWidth = false;
					this.previewOffset(10);
				} catch (error) {
					if (!this.isDisposed) {
						this.message.textContent = localize('sessions.design.vectorFailed', 'Could not calculate the vector: {0}', String(error));
					}
				} finally {
					this.running = false;
					if (!this.isDisposed) {
						this.refresh();
					}
				}
			}),
			action('offsetApply', localize('sessions.design.offsetApply', 'Apply offset'), !!this.offset, () => this.applyOffset()),
			action('offsetCancel', localize('sessions.design.offsetCancel', 'Cancel offset'), !!this.offset, () => this.cancel()),
		];
	}
	public update(): void {
		if (!this.canWidth) {
			this.selection.editingWidth = false;
		}
		if (this.offset && !this.preview) {
			this.cancel();
		}
		for (const update of this.updates) {
			update();
		}
	}
}
