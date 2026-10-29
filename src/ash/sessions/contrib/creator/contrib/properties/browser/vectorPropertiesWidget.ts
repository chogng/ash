import { defaultButtonStyles } from '../../../../../../platform/theme/browser/defaultStyles.js';
import { designPathEndpoints } from '../../../common/model/designVectorStroke.js';
import { Color } from '../../../../../../base/common/color.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { createDesignColorPicker } from '../../../browser/widgets/designColorPicker.js';
import { VectorAppearanceWidget } from './vectorAppearanceWidget.js';
import { importDesignOutlineFont, outlineDesignText } from '../../../browser/designTextOutlines.js';
import { clearDesignTextMeasurements } from '../../../browser/designTextMeasurement.js';
import {
	connectDesignNetwork,
	designNetworkRegions,
	paintDesignNetworkFromPath,
	toDesignVectorNetwork,
	withDesignVectorNetwork,
} from '../../../common/model/designVectorNetwork.js';
import { intersectDesignNetwork, simplifyDesignNetwork } from '../../../common/model/designVectorTopology.js';
import { addDisposableListener, h } from '../../../../../../base/browser/dom.js';
import { Button } from '../../../../../../base/browser/ui/button/button.js';
import type { IAction } from '../../../../../../base/common/actions.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../nls.js';
import type { DesignDocumentController } from '../../../browser/designDocumentController.js';
import {
	getDesignNetworkIntersections,
	getDesignVectorContours,
	loadDesignVectorGeometry,
} from '../../../browser/designVectorGeometry.js';
import type { DocumentCommands } from '../../../common/commands/documentCommands.js';
import { flattenDesignShapes, type DesignShape } from '../../../common/model/document.js';
import {
	designPathContours,
	designPathEditingContours,
	designPathFillContours,
	isDesignVector,
	type DesignBooleanOperation,
	type DesignPath,
} from '../../../common/model/designVector.js';
import type { DesignSelection } from '../../../common/selection.js';

function operations(): readonly [DesignBooleanOperation, string][] {
	return [
		['union', localize('sessions.design.vectorUnion', 'Union selection')],
		['subtract', localize('sessions.design.vectorSubtract', 'Subtract selection')],
		['intersect', localize('sessions.design.vectorIntersect', 'Intersect selection')],
		['exclude', localize('sessions.design.vectorExclude', 'Exclude selection')],
	];
}

/** Accessible controls and context actions share availability and the same document commands. */
export class VectorPropertiesWidget extends Disposable {
	public readonly domNode: HTMLElement;
	private readonly fields: HTMLElement;
	private readonly message: HTMLElement;
	private readonly buttons = new Map<string, Button>();
	private readonly updates: (() => void)[] = [];
	private readonly appearance: VectorAppearanceWidget;
	private running = false;
	private edgeIndex = 0;
	private regionIndex = 0;
	private simplification:
		| {
				source: DesignPath;
				network: ReturnType<typeof toDesignVectorNetwork>;
				version: string;
				result: DesignPath;
				amount: number;
		  }
		| undefined;
	constructor(
		private readonly controller: DesignDocumentController,
		private readonly commands: DocumentCommands,
		private readonly selection: DesignSelection,
		document: Document,
		private readonly refresh: () => void,
		private readonly focusCanvas: () => void,
		@IInstantiationService instantiation: IInstantiationService,
	) {
		super();
		this.domNode = h(
			document,
			'details',
			{ className: 'ash-design-property-section ash-design-vector-properties', properties: { open: true } },
			h(
				document,
				'summary',
				{ className: 'ash-design-property-disclosure' },
				localize('sessions.design.vectorTools', 'Vector tools'),
			),
		);
		const content = h(document, 'div', { className: 'ash-design-property-fields' });
		this.domNode.append(content);
		this.appearance = this._register(
			new VectorAppearanceWidget(controller, commands, selection, document, refresh, focusCanvas),
		);
		for (const action of this.getActions()) {
			const button = this._register(new Button(content, { ...defaultButtonStyles, label: action.label }));
			this.buttons.set(action.id, button);
			this._register(
				button.onDidClick(() => {
					const current = this.getActions().find(item => item.id === action.id);
					if (current?.enabled) {
						void current.run();
					}
				}),
			);
		}
		const simplifyLabel = localize('sessions.design.vectorSimplification', 'Simplification');
		const simplifyInput = h(document, 'input', {
			properties: { type: 'range', min: '0', max: '100', step: '1' },
			attributes: { 'aria-label': simplifyLabel },
		});
		const simplifyCount = h(document, 'span', { attributes: { role: 'status', 'aria-live': 'polite' } });
		const simplifyFields = h(
			document,
			'label',
			{ className: 'ash-design-property-wide' },
			simplifyLabel,
			simplifyInput,
			simplifyCount,
		);
		content.append(simplifyFields);
		this._register(
			addDisposableListener(simplifyInput, 'input', () => {
				if (!this.simplification || !this.editable || !Number.isFinite(simplifyInput.valueAsNumber)) {
					return;
				}
				this.previewSimplification(Math.max(0, Math.min(100, simplifyInput.valueAsNumber)));
				this.refresh();
			}),
		);
		this._register(
			addDisposableListener(simplifyInput, 'keydown', event => {
				if (event.key === 'Escape') {
					this.cancel();
					this.refresh();
					this.focusCanvas();
					event.preventDefault();
					event.stopPropagation();
				} else if (event.key === 'Enter') {
					this.applySimplification();
					event.preventDefault();
				}
			}),
		);
		this.updates.push(() => {
			simplifyFields.hidden = !this.simplification;
			if (this.simplification) {
				simplifyInput.value = String(this.simplification.amount);
				simplifyInput.setAttribute(
					'aria-valuetext',
					localize('sessions.design.vectorSimplificationValue', '{0} percent', this.simplification.amount),
				);
				simplifyCount.textContent = localize(
					'sessions.design.vectorSimplificationCount',
					'{0} → {1} points',
					toDesignVectorNetwork(this.simplification.source).vertices.length,
					toDesignVectorNetwork(this.simplification.result).vertices.length,
				);
			}
		});
		const fontFile = h(document, 'input', {
			properties: { type: 'file', accept: '.ttf,.otf,.ttc', hidden: true },
			attributes: { 'aria-label': localize('sessions.design.outlineFontFile', 'Font file for outlines') },
		});
		content.append(fontFile);
		const fontButton = this._register(
			new Button(content, {
				...defaultButtonStyles,
				label: localize('sessions.design.outlineLoadFont', 'Load font for outlines'),
			}),
		);
		this._register(fontButton.onDidClick(() => fontFile.click()));
		this._register(
			addDisposableListener(fontFile, 'change', async () => {
				const file = fontFile.files?.[0];
				if (!file) {
					return;
				}
				try {
					await importDesignOutlineFont(file);
					if (!this.isDisposed) {
						clearDesignTextMeasurements();
						this.message.textContent = localize(
							'sessions.design.outlineFontLoaded',
							'Font loaded. You can now convert matching text to outlines.',
						);
						this.refresh();
					}
				} catch (error) {
					if (!this.isDisposed) {
						this.message.textContent = String(error);
					}
				} finally {
					fontFile.value = '';
				}
			}),
		);
		this.updates.push(() => {
			fontButton.domNode.hidden = !this.selected.some(shape => shape.kind === 'text');
			fontButton.enabled = this.editable;
		});
		this.fields = h(document, 'div', { className: 'ash-design-property-fields ash-design-property-wide' });
		content.append(this.fields);
		const select = (
			label: string,
			options: readonly (readonly [string, string])[],
			value: () => string,
			change: (value: string) => void,
		) => {
			const input = h(
				document,
				'select',
				{ attributes: { 'aria-label': label } },
				...options.map(([value, label]) => h(document, 'option', { properties: { value } }, label)),
			);
			this.fields.append(h(document, 'label', { className: 'ash-design-property-wide' }, label, input));
			this._register(
				addDisposableListener(input, 'change', () => {
					if (this.editable) {
						change(input.value);
						this.refresh();
					}
				}),
			);
			this.updates.push(() => {
				input.value = value();
				input.disabled = !this.editable;
			});
			return input;
		};
		const contour = select(
			localize('sessions.design.vectorContour', 'Contour'),
			[],
			() => String(this.path?.network ? 0 : this.selection.contourIndex),
			value => {
				this.selection.contourIndex = Number(value);
				this.selection.nodeIndex = 0;
				this.selection.editingVector = true;
			},
		);
		this.updates.unshift(() => {
			contour.replaceChildren(
				...(this.path ? designPathEditingContours(this.path) : []).map((_, i) =>
					h(document, 'option', { properties: { value: String(i) } }, String(i + 1)),
				),
			);
		});
		select(
			localize('sessions.design.vectorMirroring', 'Handle mirroring'),
			[
				['none', localize('sessions.design.vectorIndependent', 'None')],
				['angle', localize('sessions.design.vectorAngle', 'Angle')],
				['angle-length', localize('sessions.design.vectorAngleLength', 'Angle and length')],
			],
			() =>
				this.path
					? (designPathEditingContours(this.path)[this.selection.contourIndex]?.nodes[
							this.selection.nodeIndex
						]?.mirroring ?? 'none')
					: 'none',
			value => {
				if (this.path) {
					this.commands.vector.setMirroring(
						this.path,
						this.selection.contourIndex,
						this.selection.nodeIndices,
						value as 'none' | 'angle' | 'angle-length',
					);
				}
			},
		);
		select(
			localize('sessions.design.vectorFillRule', 'Fill rule'),
			[
				['nonzero', localize('sessions.design.vectorNonzero', 'Nonzero')],
				['evenodd', localize('sessions.design.vectorEvenOdd', 'Even odd')],
			],
			() => this.path?.fillRule ?? 'nonzero',
			value => {
				if (this.path) {
					this.commands.updateShape({ ...this.path, fillRule: value as 'nonzero' | 'evenodd' });
				}
			},
		);
		select(
			localize('sessions.design.vectorCap', 'Stroke cap'),
			[
				['butt', localize('sessions.design.vectorButt', 'Butt')],
				['round', localize('sessions.design.vectorRound', 'Round')],
				['square', localize('sessions.design.vectorSquare', 'Square')],
			],
			() => this.path?.strokeCap ?? 'butt',
			value => {
				if (this.path) {
					this.commands.vector.setEndpoints(
						{ ...this.path, strokeCap: value as 'butt' | 'round' | 'square' },
						designPathEndpoints(this.path),
						undefined,
					);
				}
			},
		);
		select(
			localize('sessions.design.vectorJoin', 'Stroke join'),
			[
				['miter', localize('sessions.design.vectorMiter', 'Miter')],
				['round', localize('sessions.design.vectorRound', 'Round')],
				['bevel', localize('sessions.design.vectorBevel', 'Bevel')],
			],
			() => this.path?.strokeJoin ?? 'miter',
			value => {
				if (this.path) {
					this.commands.updateShape({ ...this.path, strokeJoin: value as 'miter' | 'round' | 'bevel' });
				}
			},
		);
		const stroke = this._register(
			createDesignColorPicker(instantiation, document, {
				color: localize('sessions.design.vectorStroke', 'Stroke color'),
				value: localize('sessions.design.vectorStroke', 'Stroke color'),
				opacity: localize('sessions.design.strokeOpacity', 'Stroke opacity (%)'),
			}),
		);
		stroke.domNode.classList.add('ash-design-property-wide');
		this.fields.append(stroke.domNode);
		this._register(
			stroke.onDidCommitColor(color => {
				if (this.path && this.editable) {
					this.commands.updateShape({ ...this.path, stroke: Color.Format.CSS.formatHexA(color, true) });
				}
			}),
		);
		const resetStroke = this._register(
			new Button(this.fields, {
				...defaultButtonStyles,
				label: localize('sessions.design.strokeReset', 'Use fill color for stroke'),
				onClick: () => {
					if (this.path && this.editable) {
						this.commands.updateShape({ ...this.path, stroke: undefined });
					}
				},
			}),
		);
		this.updates.push(() => {
			stroke.enabled = this.editable;
			stroke.setColor(
				Color.Format.CSS.parseHex(this.path?.stroke ?? this.path?.fill ?? '#000000')!,
				this.path?.id,
			);
			resetStroke.enabled = this.editable && this.path?.stroke !== undefined;
		});
		const dash = h(document, 'input', {
			attributes: { 'aria-label': localize('sessions.design.vectorDash', 'Dash pattern') },
		});
		this.fields.append(
			h(
				document,
				'label',
				{ className: 'ash-design-property-wide' },
				localize('sessions.design.vectorDash', 'Dash pattern'),
				dash,
			),
		);
		this._register(
			addDisposableListener(dash, 'change', () => {
				if (!this.path || !this.editable) {
					return;
				}
				const values = dash.value
					.trim()
					.split(/[\s,]+/u)
					.map(Number);
				const valid =
					!dash.value.trim() ||
					(values.length <= 32 && values.every(value => Number.isFinite(value) && value >= 0.01));
				dash.setCustomValidity(
					valid ? '' : localize('sessions.design.vectorInvalidStyle', 'Enter positive dash lengths.'),
				);
				if (!valid) {
					dash.reportValidity();
					return;
				}
				this.commands.updateShape({
					...this.path,
					dashArray: dash.value.trim() ? values : undefined,
					...(dash.value.trim() ? { widthPoints: undefined } : {}),
				});
			}),
		);
		this.updates.push(() => {
			dash.value = this.path?.dashArray?.join(' ') ?? '';
			dash.disabled = !this.editable;
		});
		const networkFields = h(document, 'div', { className: 'ash-design-property-fields ash-design-property-wide' });
		content.append(networkFields);
		const edgeLabel = localize('sessions.design.networkEdge', 'Network segment');
		const edgeInput = h(document, 'select', { attributes: { 'aria-label': edgeLabel } });
		networkFields.append(h(document, 'label', { className: 'ash-design-property-wide' }, edgeLabel, edgeInput));
		this._register(
			addDisposableListener(edgeInput, 'change', () => {
				this.edgeIndex = Number(edgeInput.value);
				this.update();
			}),
		);
		for (const [point, axis, label] of [
			['outgoing', 'x', localize('sessions.design.networkStartX', 'Segment start handle X')],
			['outgoing', 'y', localize('sessions.design.networkStartY', 'Segment start handle Y')],
			['incoming', 'x', localize('sessions.design.networkEndX', 'Segment end handle X')],
			['incoming', 'y', localize('sessions.design.networkEndY', 'Segment end handle Y')],
		] as const) {
			const input = h(document, 'input', {
				properties: { type: 'number', step: 'any' },
				attributes: { 'aria-label': label },
			});
			networkFields.append(h(document, 'label', {}, label, input));
			this._register(
				addDisposableListener(input, 'change', () => {
					const path = this.path,
						network = path?.network;
					if (!path || !network || !this.editable || !Number.isFinite(input.valueAsNumber)) {
						return;
					}
					this.commands.vector.update(
						withDesignVectorNetwork(path, {
							...network,
							edges: network.edges.map((edge, i) =>
								i === this.edgeIndex
									? {
											...edge,
											[point]: {
												...edge[point],
												[axis]: input.valueAsNumber / (axis === 'x' ? path.width : path.height),
											},
										}
									: edge,
							),
						}),
					);
				}),
			);
			this.updates.push(() => {
				const path = this.path;
				input.value = String(
					(path?.network?.edges[this.edgeIndex]?.[point][axis] ?? 0) *
						(axis === 'x' ? (path?.width ?? 1) : (path?.height ?? 1)),
				);
				input.disabled = !this.editable;
			});
		}
		const regionLabel = localize('sessions.design.networkRegion', 'Fill region');
		const regionInput = h(document, 'select', { attributes: { 'aria-label': regionLabel } });
		const filledLabel = localize('sessions.design.networkRegionFilled', 'Region filled');
		const filled = h(document, 'input', {
			properties: { type: 'checkbox' },
			attributes: { 'aria-label': filledLabel },
		});
		networkFields.append(
			h(document, 'label', {}, regionLabel, regionInput),
			h(document, 'label', {}, filledLabel, filled),
		);
		this._register(
			addDisposableListener(regionInput, 'change', () => {
				this.regionIndex = Number(regionInput.value);
				this.update();
			}),
		);
		this._register(
			addDisposableListener(filled, 'change', () => {
				const path = this.path,
					network = path?.network;
				if (!path || !network || !this.editable) {
					return;
				}
				const region = designNetworkRegions(network)[this.regionIndex];
				if (!region) {
					return;
				}
				const keys = new Set(network.unfilledRegions);
				if (filled.checked) {
					keys.delete(region.key);
				} else {
					keys.add(region.key);
				}
				this.commands.vector.update(withDesignVectorNetwork(path, { ...network, unfilledRegions: [...keys] }));
			}),
		);
		const paintLabel = localize('sessions.design.networkPaint', 'Paint regions');
		const paint = h(document, 'input', {
			properties: { type: 'checkbox' },
			attributes: { 'aria-label': paintLabel },
		});
		networkFields.append(h(document, 'label', {}, paintLabel, paint));
		this._register(
			addDisposableListener(paint, 'change', () => {
				this.selection.paintingVector = paint.checked;
				this.selection.editingVector = true;
				this.focusCanvas();
				this.refresh();
			}),
		);
		const regionColor = this._register(
			createDesignColorPicker(instantiation, document, {
				color: localize('sessions.design.networkRegionColor', 'Region color'),
				value: localize('sessions.design.networkRegionColor', 'Region color'),
				opacity: localize('sessions.design.regionOpacity', 'Region opacity (%)'),
			}),
		);
		regionColor.domNode.classList.add('ash-design-property-wide');
		networkFields.append(regionColor.domNode);
		this._register(
			regionColor.onDidCommitColor(color => {
				const path = this.path,
					network = path?.network;
				if (!path || !network || !this.editable) {
					return;
				}
				const region = designNetworkRegions(network)[this.regionIndex];
				if (!region) {
					return;
				}
				this.commands.vector.update(
					withDesignVectorNetwork(path, {
						...network,
						regionFills: { ...network.regionFills, [region.key]: Color.Format.CSS.formatHexA(color, true) },
					}),
				);
			}),
		);
		const resetRegion = this._register(
			new Button(networkFields, {
				...defaultButtonStyles,
				label: localize('sessions.design.regionReset', 'Use path color for region'),
				onClick: () => {
					const path = this.path,
						network = path?.network;
					if (!path || !network || !this.editable) {
						return;
					}
					const region = designNetworkRegions(network)[this.regionIndex];
					if (!region) {
						return;
					}
					const regionFills = { ...network.regionFills };
					delete regionFills[region.key];
					this.commands.vector.update(withDesignVectorNetwork(path, { ...network, regionFills }));
				},
			}),
		);
		this.updates.unshift(() => {
			const network = this.path?.network;
			networkFields.hidden = !network;
			this.edgeIndex = Math.min(this.edgeIndex, Math.max(0, (network?.edges.length ?? 1) - 1));
			edgeInput.replaceChildren(
				...(network?.edges ?? []).map((edge, i) =>
					h(
						document,
						'option',
						{ properties: { value: String(i) } },
						localize(
							'sessions.design.networkEdgeLabel',
							'{0}: {1} → {2}',
							i + 1,
							edge.start + 1,
							edge.end + 1,
						),
					),
				),
			);
			edgeInput.value = String(this.edgeIndex);
			edgeInput.disabled = !this.editable;
			const regions = network ? designNetworkRegions(network) : [];
			this.regionIndex = Math.min(this.regionIndex, Math.max(0, regions.length - 1));
			regionInput.replaceChildren(
				...regions.map((_, i) => h(document, 'option', { properties: { value: String(i) } }, String(i + 1))),
			);
			regionInput.value = String(this.regionIndex);
			paint.checked = this.selection.paintingVector;
			paint.disabled = !this.editable;
			regionColor.enabled = this.editable && !!regions.length;
			regionColor.setColor(
				Color.Format.CSS.parseHex(
					network?.regionFills?.[regions[this.regionIndex]?.key] ?? this.path?.fill ?? '#000000',
				)!,
				`${this.path?.id}:${regions[this.regionIndex]?.key}`,
			);
			resetRegion.enabled = this.editable && !!network?.regionFills?.[regions[this.regionIndex]?.key];
			filled.checked = regions[this.regionIndex]?.filled ?? false;
			filled.disabled = regionInput.disabled = !this.editable || !regions.length;
		});
		content.append(this.appearance.domNode);
		this.message = h(document, 'div', {
			className: 'ash-design-property-wide',
			attributes: { role: 'status', 'aria-live': 'polite' },
		});
		content.append(this.message);
	}
	private get selected(): readonly DesignShape[] {
		return flattenDesignShapes(this.controller.model.value.shapes).filter(shape =>
			this.selection.ids.has(shape.id),
		);
	}
	private get shape(): DesignShape | undefined {
		return this.selection.ids.size === 1
			? flattenDesignShapes(this.controller.model.value.shapes).find(shape => this.selection.ids.has(shape.id))
			: undefined;
	}
	private get path(): DesignPath | undefined {
		const shape = this.shape;
		return shape?.kind === 'path' ? shape : undefined;
	}
	private get editable(): boolean {
		return (
			!this.running &&
			!this.appearance.preview &&
			!this.controller.isBusy &&
			this.selected.every(shape => !this.commands.components.isInstanceChild(shape.id))
		);
	}
	public get preview(): DesignPath | undefined {
		if (this.appearance.preview) {
			return this.appearance.preview;
		}
		return this.simplification &&
			this.simplification.version === this.controller.model.version &&
			this.path?.id === this.simplification.source.id
			? this.simplification.result
			: undefined;
	}
	public cancel(): void {
		this.simplification = undefined;
		this.appearance.cancel();
	}
	private previewSimplification(amount: number): void {
		const source = this.simplification?.source ?? this.path;
		if (!source) {
			return;
		}
		let network = this.simplification?.network;
		if (!network) {
			const original = toDesignVectorNetwork(source);
			network = intersectDesignNetwork(
				original,
				getDesignNetworkIntersections(original, source.width, source.height),
			).network;
			if (!source.network) {
				network = paintDesignNetworkFromPath(source, network);
			}
		}
		const result = simplifyDesignNetwork(network, source.width, source.height, amount / 20);
		this.simplification = {
			source,
			network,
			version: this.controller.model.version,
			amount,
			result: result.network === network ? source : withDesignVectorNetwork(source, result.network),
		};
	}
	private applySimplification(): void {
		const preview = this.preview;
		if (!preview || !this.editable) {
			return;
		}
		const source = this.simplification!.source;
		this.cancel();
		if (preview !== source) {
			this.commands.vector.update(preview);
			this.selection.selectNode(0, 0);
		}
		this.refresh();
		this.focusCanvas();
	}
	public getActions(): readonly IAction[] {
		const shape = this.shape,
			path = this.path,
			editable = this.editable;
		const hasText = this.selected.some(shape => shape.kind === 'text');
		const canFlattenText =
			hasText &&
			this.selected.every(shape => shape.kind === 'text' || isDesignVector(shape)) &&
			(this.selected.length === 1 || this.commands.canGroup(this.selection.ids));
		const action = (id: string, label: string, enabled: boolean, run: () => unknown): IAction => ({
			id: `sessions.design.${id}`,
			label,
			tooltip: label,
			enabled: editable && enabled,
			run: () => {
				try {
					const result = run();
					this.focusCanvas();
					return result;
				} catch (error) {
					this.message.textContent = localize(
						'sessions.design.vectorFailed',
						'Could not calculate the vector: {0}',
						String(error),
					);
				}
			},
		});
		return [
			...this.appearance
				.getActions()
				.map(action => ({ ...action, enabled: action.enabled && !this.simplification && !this.running })),
			action(
				'networkIntersections',
				localize('sessions.design.networkIntersections', 'Add intersection nodes'),
				!!path && !this.simplification,
				() =>
					this.geometry(() => {
						if (!path) {
							return;
						}
						const network = toDesignVectorNetwork(path),
							hits = getDesignNetworkIntersections(network, path.width, path.height);
						if (hits.length) {
							const result = intersectDesignNetwork(network, hits);
							this.commands.vector.update(
								withDesignVectorNetwork(
									path,
									path.network ? result.network : paintDesignNetworkFromPath(path, result.network),
								),
							);
							this.selection.selectNode(0, result.vertices.get(this.selection.nodeIndex) ?? 0);
						}
						this.message.textContent = hits.length
							? localize(
									'sessions.design.networkIntersectionsComplete',
									'Crossings now share editable nodes.',
								)
							: localize('sessions.design.networkNoIntersections', 'No unconnected intersections found.');
					}),
			),
			action(
				'networkMerge',
				localize('sessions.design.networkMerge', 'Merge selected nodes'),
				!!path && this.selection.editingVector && this.selection.nodeIndices.size > 1 && !this.simplification,
				() => {
					if (path) {
						const index = this.commands.vector.mergeNodes(
							path,
							this.selection.contourIndex,
							this.selection.nodeIndices,
						);
						this.selection.selectNode(0, index);
						this.refresh();
					}
				},
			),
			action(
				'vectorHeal',
				localize('sessions.design.vectorHeal', 'Delete and heal'),
				!!path && this.selection.editingVector && this.selection.nodeIndices.size > 0 && !this.simplification,
				() => {
					if (path) {
						this.commands.vector.healNodes(path, this.selection.contourIndex, this.selection.nodeIndices);
						this.selection.selectNode(0, 0);
						this.refresh();
					}
				},
			),
			action(
				'vectorSimplify',
				localize('sessions.design.vectorSimplify', 'Simplify vector'),
				!!path && !this.simplification,
				() => this.geometry(() => this.previewSimplification(20)),
			),
			action(
				'vectorSimplifyApply',
				localize('sessions.design.vectorSimplifyApply', 'Apply simplification'),
				!!this.simplification,
				() => this.applySimplification(),
			),
			action(
				'vectorSimplifyCancel',
				localize('sessions.design.vectorSimplifyCancel', 'Cancel simplification'),
				!!this.simplification,
				() => {
					this.cancel();
					this.refresh();
				},
			),
			...operations().map(([operation, label]) =>
				action(
					`vector${operation}`,
					label,
					this.commands.canCombine(this.selection.ids) ||
						(shape?.kind === 'group' && !!shape.booleanOperation),
					() =>
						this.geometry(() => {
							if (shape?.kind === 'group' && shape.booleanOperation) {
								this.commands.updateShape({ ...shape, booleanOperation: operation });
							} else {
								const id = this.commands.group(this.selection.ids, operation);
								if (id) {
									this.selection.set([id]);
								}
							}
						}),
				),
			),
			action(
				'vectorFlatten',
				localize('sessions.design.vectorFlatten', 'Flatten selection'),
				canFlattenText || (!!shape && isDesignVector(shape)) || this.commands.canCombine(this.selection.ids),
				() =>
					canFlattenText
						? this.outlineText(false)
						: this.geometry(() => {
								if (!shape) {
									const id = this.commands.flatten(this.selection.ids, getDesignVectorContours);
									if (id) {
										this.selection.set([id]);
										this.selection.editingVector = true;
									}
								} else if (shape) {
									const contours =
										shape.kind === 'path' && !shape.strokeWidth
											? designPathFillContours(shape)
											: getDesignVectorContours(shape);
									if (contours.length) {
										this.commands.vector.replace(shape, contours);
										this.selection.editingVector = true;
									} else {
										this.message.textContent = localize(
											'sessions.design.vectorEmpty',
											'The result is empty. Move the original layers to change the overlap.',
										);
									}
								}
							}),
			),
			action(
				'vectorOutline',
				localize('sessions.design.vectorOutline', 'Outline stroke'),
				(hasText && this.selected.every(shape => shape.kind === 'text')) || !!path?.strokeWidth,
				() =>
					hasText
						? this.outlineText(true)
						: this.geometry(() => {
								if (path) {
									this.commands.vector.replace(path, getDesignVectorContours(path, true), true);
									this.selection.editingVector = true;
								}
							}),
			),
			action(
				'vectorConvert',
				localize('sessions.design.vectorConvert', 'Convert to path'),
				shape?.kind === 'rectangle' || shape?.kind === 'ellipse',
				() => {
					if (shape) {
						this.commands.vector.convert(shape);
						this.selection.editingVector = true;
						this.refresh();
					}
				},
			),
			action('vectorEdit', localize('sessions.design.vectorEdit', 'Edit vector'), !!path, () => {
				this.selection.editingVector = true;
				this.refresh();
			}),
			action(
				'vectorNetwork',
				localize('sessions.design.vectorNetwork', 'Convert to vector network'),
				!!path && !path.network,
				() => {
					if (path) {
						this.selection.selectNode(0, 0);
						this.commands.vector.update(withDesignVectorNetwork(path, toDesignVectorNetwork(path)));
					}
				},
			),
			action(
				'networkConnect',
				localize('sessions.design.networkConnect', 'Connect selected nodes'),
				!!path?.network && this.selection.nodeIndices.size === 2,
				() => {
					const indices = [...this.selection.nodeIndices];
					return this.geometry(() => {
						if (path?.network) {
							const [start, end] = indices,
								network = connectDesignNetwork(path.network, start, end);
							const result = intersectDesignNetwork(
								network,
								getDesignNetworkIntersections(network, path.width, path.height),
								path.network,
							);
							this.commands.vector.update(withDesignVectorNetwork(path, result.network));
							this.selection.selectNode(0, result.vertices.get(end) ?? 0);
						}
					});
				},
			),
			action('networkSplit', localize('sessions.design.networkSplit', 'Split segment'), !!path?.network, () => {
				if (path?.network) {
					this.selection.nodeIndex = path.network.vertices.length;
					this.commands.vector.insertNode(path, this.edgeIndex, 0);
				}
			}),
			action(
				'networkDeleteEdge',
				localize('sessions.design.networkDeleteEdge', 'Delete segment'),
				!!path?.network && path.network.edges.length > 1,
				() => {
					if (path?.network) {
						const removed = path.network.edges[this.edgeIndex].id;
						this.commands.vector.update(
							withDesignVectorNetwork(path, {
								...path.network,
								edges: path.network.edges.filter((_, i) => i !== this.edgeIndex),
								unfilledRegions: path.network.unfilledRegions?.filter(
									key => !key.split(',').includes(removed),
								),
								regionFills: path.network.regionFills
									? Object.fromEntries(
											Object.entries(path.network.regionFills).filter(
												([key]) => !key.split(',').includes(removed),
											),
										)
									: undefined,
							}),
						);
					}
				},
			),
			action('vectorCorner', localize('sessions.design.vectorCorner', 'Make corner'), !!path, () => {
				if (path) {
					this.commands.vector.corner(path, this.selection.contourIndex, this.selection.nodeIndices);
				}
			}),
			action('vectorSmooth', localize('sessions.design.vectorSmooth', 'Make smooth'), !!path, () => {
				if (path) {
					this.commands.vector.setMirroring(
						path,
						this.selection.contourIndex,
						this.selection.nodeIndices,
						'angle-length',
					);
				}
			}),
			action('vectorReverse', localize('sessions.design.vectorReverse', 'Reverse path'), !!path, () => {
				if (path) {
					this.commands.vector.reverse(path, this.selection.contourIndex);
				}
			}),
			action('vectorCut', localize('sessions.design.vectorCut', 'Cut at node'), !!path, () => {
				if (path) {
					this.commands.vector.cut(path, this.selection.contourIndex, this.selection.nodeIndex);
				}
			}),
			action(
				'vectorJoin',
				localize('sessions.design.vectorJoinContours', 'Join contours'),
				!!path && !path.network && designPathContours(path).filter(contour => !contour.closed).length >= 2,
				() => {
					if (path) {
						const contours = designPathContours(path);
						const next = contours.findIndex(
							(contour, index) => index !== this.selection.contourIndex && !contour.closed,
						);
						this.commands.vector.join(path, this.selection.contourIndex, next);
					}
				},
			),
		];
	}
	private async outlineText(splitGlyphs: boolean): Promise<void> {
		if (!this.editable || this.selected.some(shape => this.commands.components.isInstanceChild(shape.id))) {
			return;
		}
		const selected = this.selected,
			version = this.controller.model.version,
			ids = [...this.selection.ids].join(',');
		this.running = true;
		this.update();
		try {
			const converted: DesignShape[] = [];
			for (const shape of selected) {
				converted.push(shape.kind === 'text' ? await outlineDesignText(shape, splitGlyphs) : shape);
			}
			if (!splitGlyphs && converted.length > 1) {
				await loadDesignVectorGeometry();
			}
			if (
				this.isDisposed ||
				version !== this.controller.model.version ||
				ids !== [...this.selection.ids].join(',')
			) {
				return;
			}
			if (splitGlyphs || converted.length === 1) {
				this.commands.updateShapes(converted);
			} else {
				const id = this.commands.flatten(
					this.selection.ids,
					getDesignVectorContours,
					new Map(converted.map(shape => [shape.id, shape])),
				);
				if (id) {
					this.selection.set([id]);
				}
			}
			this.selection.editingVector = !splitGlyphs;
			this.message.textContent = localize(
				'sessions.design.outlineComplete',
				'Text converted to editable vector paths. Undo restores the text.',
			);
			this.refresh();
		} catch (error) {
			if (!this.isDisposed) {
				this.message.textContent = localize(
					'sessions.design.vectorFailed',
					'Could not calculate the vector: {0}',
					String(error),
				);
			}
		} finally {
			this.running = false;
			if (!this.isDisposed) {
				this.update();
			}
		}
	}
	private async geometry(edit: () => void): Promise<void> {
		if (!this.editable) {
			return;
		}
		const version = this.controller.model.version,
			ids = [...this.selection.ids].join(',');
		this.running = true;
		this.update();
		try {
			await loadDesignVectorGeometry();
			if (
				!this.isDisposed &&
				version === this.controller.model.version &&
				ids === [...this.selection.ids].join(',')
			) {
				edit();
				this.refresh();
			}
		} catch (error) {
			if (!this.isDisposed) {
				this.message.textContent = localize(
					'sessions.design.vectorFailed',
					'Could not calculate the vector: {0}',
					String(error),
				);
			}
		} finally {
			this.running = false;
			if (!this.isDisposed) {
				this.update();
			}
		}
	}
	public update(): void {
		this.appearance.update();
		if (this.simplification && !this.preview) {
			this.cancel();
		}
		this.domNode.hidden = !this.path && !this.getActions().some(action => action.enabled) && !this.running;
		if (this.path) {
			this.selection.contourIndex = Math.min(
				this.selection.contourIndex,
				designPathEditingContours(this.path).length - 1,
			);
		}
		for (const action of this.getActions()) {
			const button = this.buttons.get(action.id);
			if (button) {
				button.enabled = action.enabled;
				button.domNode.hidden = !action.enabled && !this.running;
				if (action.id === 'sessions.design.variableWidth') {
					button.domNode.setAttribute('aria-pressed', String(this.selection.editingWidth));
				}
			}
		}
		this.fields.hidden = !this.path;
		for (const update of this.updates) {
			update();
		}
	}
}
