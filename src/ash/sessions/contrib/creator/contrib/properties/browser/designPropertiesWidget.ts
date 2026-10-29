import { defaultButtonStyles } from '../../../../../../platform/theme/browser/defaultStyles.js';
import { EffectPropertiesWidget } from './effectPropertiesWidget.js';
import { PaintPropertiesWidget } from './paintPropertiesWidget.js';
import { designPaints, withDesignPaintColor } from '../../../common/model/designPaint.js';
import { VectorPropertiesWidget } from './vectorPropertiesWidget.js';
import { designPathEditingContours, moveDesignPathNode } from '../../../common/model/designVector.js';
import { TextPropertiesWidget } from './textPropertiesWidget.js';
import type { IDesignTextContribution } from '../../../browser/designEditorBrowser.js';
import './designPropertiesWidget.css';
import { addDisposableListener, h } from '../../../../../../base/browser/dom.js';
import { Button } from '../../../../../../base/browser/ui/button/button.js';
import { Color } from '../../../../../../base/common/color.js';
import type { IAction } from '../../../../../../base/common/actions.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../nls.js';
import type { DesignPoint } from '../../../common/core/geometry.js';
import type { DocumentCommands } from '../../../common/commands/documentCommands.js';
import type { DesignDocumentController } from '../../../browser/designDocumentController.js';
import { flattenDesignShapes, type DesignAutoLayout, type DesignConstraint, type DesignGrid, type DesignGridTrack, type DesignImageCrop, type DesignShape } from '../../../common/model/document.js';
import { getDesignGridCells } from '../../../common/model/layout.js';
import { getDesignShapeEntries } from '../../../common/model/hitTest.js';
import type { DesignSelection } from '../../../common/selection.js';
import { ResourcePropertiesWidget } from './resourcePropertiesWidget.js';
import { ComponentPropertiesWidget } from './componentPropertiesWidget.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { createDesignColorPicker } from '../../../browser/widgets/designColorPicker.js';
import { ColorPicker } from '../../../../../../base/browser/ui/colorPicker/colorPicker.js';

type GeometryField = 'x' | 'y' | 'width' | 'height' | 'rotation';

/** Owns geometry, text and path-property controls; edits use the shared document history. */
export class DesignPropertiesWidget extends Disposable {
	public readonly domNode: HTMLElement;
	private readonly headingDomNode: HTMLElement;
	private readonly vectorProperties: VectorPropertiesWidget;
	private readonly componentProperties: ComponentPropertiesWidget;
	private readonly resourceProperties: ResourcePropertiesWidget;
	private readonly nameInput: HTMLInputElement;
	private readonly arrangementProperties: HTMLElement;
	private readonly arrangementButtons: { button: Button; enabled: () => boolean }[] = [];
	private readonly autoLayoutProperties: HTMLElement;
	private readonly autoLayoutFields: HTMLElement;
	private readonly constraintsProperties: HTMLElement;
	private readonly sizingProperties: HTMLElement;
	private readonly gridProperties: HTMLElement;
	private readonly gridCellProperties: HTMLElement;
	private readonly limitsProperties: HTMLElement;
	private readonly layoutRefresh: (() => void)[] = [];
	private readonly pageDomNode: HTMLElement;
	private readonly pageColor: ColorPicker;
	private pageColorPreview: string | undefined;
	private readonly positionSection: HTMLDetailsElement;
	private readonly layoutSection: HTMLDetailsElement;
	private readonly geometryInputs = new Map<GeometryField, HTMLInputElement>();
	private readonly appearanceProperties: HTMLElement;
	private readonly paints: PaintPropertiesWidget;
	private readonly effects: EffectPropertiesWidget;
	private readonly effectProperties: HTMLElement;
	private readonly fillColor: ColorPicker;
	private readonly fillDomNode: HTMLElement;
	private readonly exportButton: Button;
	private readonly exportFormatInput: HTMLSelectElement;
	private isCommittingColor = false;
	private colorPreview: DesignShape | undefined;
	private readonly textProperties: HTMLElement;
	private readonly typography: TextPropertiesWidget;
	private readonly imageProperties: HTMLElement;
	private readonly cropInputs = new Map<keyof DesignImageCrop, HTMLInputElement>();
	private readonly frameProperties: HTMLElement;
	private readonly clipInput: HTMLInputElement;
	private readonly pathProperties: HTMLElement;
	private readonly nodeInput: HTMLSelectElement;
	private readonly closedInput: HTMLInputElement;
	private readonly strokeWidthInput: HTMLInputElement;
	private readonly pathInputs = new Map<string, HTMLInputElement>();

	constructor(
		ownerDocument: Document,
		private readonly documentController: DesignDocumentController,
		private readonly commands: DocumentCommands,
		private readonly selection: DesignSelection,
		private readonly refresh: () => void,
		private readonly exportDesign: (format: 'svg' | 'html') => Promise<void>,
		text: IDesignTextContribution,
		focusCanvas: () => void,
		@IInstantiationService instantiation: IInstantiationService,
	) {
		super();
		this.domNode = h(ownerDocument, 'div', {
			className: 'ash-sessions-design-properties',
			attributes: { role: 'group', 'aria-label': localize('sessions.design.properties', 'Shape properties') },
		});
		this.headingDomNode = h(ownerDocument, 'h2', {
			className: 'ash-design-properties-heading',
			attributes: { tabindex: '-1' },
		});
		this.domNode.append(this.headingDomNode);
		this.pageColor = this._register(
			createDesignColorPicker(instantiation, ownerDocument, {
				color: localize('sessions.design.pageBackground', 'Page background'),
				value: localize('sessions.design.pageBackgroundColor', 'Page background color'),
				opacity: localize('sessions.design.pageBackgroundOpacity', 'Page background opacity (%)'),
			}),
		);
		this._register(
			this.pageColor.onDidChangeColor(color => {
				this.pageColorPreview = Color.Format.CSS.formatHexA(color, true);
				this.refresh();
			}),
		);
		this._register(
			this.pageColor.onDidClose(() => {
				this.pageColorPreview = undefined;
				this.refresh();
			}),
		);
		this._register(this.pageColor.onDidCommitColor(color => this.commitColor(color, this.pageColor)));
		this.pageDomNode = h(ownerDocument, 'div', { className: 'ash-design-page-properties' }, this.pageColor.domNode);
		this.domNode.append(this.pageDomNode);
		this.componentProperties = this._register(new ComponentPropertiesWidget(documentController, commands.components, selection, ownerDocument, refresh));
		this.domNode.append(this.componentProperties.domNode);
		this.resourceProperties = this._register(instantiation.createInstance(ResourcePropertiesWidget, documentController, commands, selection, ownerDocument));
		this.domNode.append(this.resourceProperties.domNode);
		this.vectorProperties = this._register(instantiation.createInstance(VectorPropertiesWidget, documentController, commands, selection, ownerDocument, refresh, focusCanvas));
		const layer = this.createSection(localize('sessions.design.layer', 'Layer'));
		this.nameInput = h(ownerDocument, 'input', {
			properties: { type: 'text', maxLength: 1024 },
			attributes: { 'aria-label': localize('sessions.design.layerName', 'Layer name') },
		});
		layer.append(h(ownerDocument, 'label', { className: 'ash-design-property-wide' }, localize('sessions.design.layerName', 'Layer name'), this.nameInput));
		this._register(
			addDisposableListener(this.nameInput, 'change', () => {
				const shape = this.selectedShape;
				if (shape && !this.documentController.isBusy) {
					this.commands.updateShape({ ...shape, name: this.nameInput.value.trim() });
				}
			}),
		);
		this.arrangementProperties = this.createSection(localize('sessions.design.arrange', 'Arrange'));
		(this.arrangementProperties.parentElement as HTMLDetailsElement).open = false;
		const arrangeButton = (label: string, run: () => void, enabled: () => boolean): void => {
			const button = this._register(
				new Button(this.arrangementProperties, {
					...defaultButtonStyles,
					label,
					onClick: run,
				}),
			);
			this.arrangementButtons.push({ button, enabled });
		};
		const canReorder = (): boolean => [...this.selection.ids].some(id => !this.commands.components.isInstanceChild(id));
		arrangeButton(
			localize('sessions.design.duplicate', 'Duplicate'),
			() => {
				const ids = this.commands.duplicate(this.selection.ids);
				if (ids.length) {
					this.selection.set(ids);
				}
				this.refresh();
			},
			canReorder,
		);
		for (const [order, label] of [
			['front', localize('sessions.design.bringToFront', 'Bring to front')],
			['back', localize('sessions.design.sendToBack', 'Send to back')],
			['forward', localize('sessions.design.bringForward', 'Bring forward')],
			['backward', localize('sessions.design.sendBackward', 'Send backward')],
		] as const) {
			arrangeButton(label, () => this.commands.reorder(this.selection.ids, order), canReorder);
		}
		for (const [axis, alignment, label] of [
			['horizontal', 'start', localize('sessions.design.alignLeft', 'Align left')],
			['horizontal', 'center', localize('sessions.design.alignHorizontalCenter', 'Align horizontal centers')],
			['horizontal', 'end', localize('sessions.design.alignRight', 'Align right')],
			['vertical', 'start', localize('sessions.design.alignTop', 'Align top')],
			['vertical', 'center', localize('sessions.design.alignVerticalCenter', 'Align vertical centers')],
			['vertical', 'end', localize('sessions.design.alignBottom', 'Align bottom')],
		] as const) {
			arrangeButton(
				label,
				() => this.commands.align(this.selection.ids, axis, alignment),
				() => this.commands.canArrange(this.selection.ids),
			);
		}
		for (const [axis, label] of [
			['horizontal', localize('sessions.design.distributeHorizontal', 'Distribute horizontal spacing')],
			['vertical', localize('sessions.design.distributeVertical', 'Distribute vertical spacing')],
		] as const) {
			arrangeButton(
				label,
				() => this.commands.distribute(this.selection.ids, axis),
				() => this.commands.canArrange(this.selection.ids, 3),
			);
		}
		arrangeButton(
			localize('sessions.design.addAutoLayout', 'Add auto layout'),
			() => {
				const id = this.commands.addAutoLayout(this.selection.ids);
				if (id) {
					this.selection.set([id]);
					this.refresh();
				}
			},
			() => this.commands.canAddAutoLayout(this.selection.ids),
		);
		const position = this.createSection(localize('sessions.design.position', 'Position'));
		this.positionSection = position.parentElement as HTMLDetailsElement;
		const layout = this.createSection(localize('sessions.design.layout', 'Layout'));
		this.layoutSection = layout.parentElement as HTMLDetailsElement;
		for (const [field, label] of [
			['x', localize('sessions.design.x', 'X')],
			['y', localize('sessions.design.y', 'Y')],
			['width', localize('sessions.design.width', 'Width')],
			['height', localize('sessions.design.height', 'Height')],
			['rotation', localize('sessions.design.rotation', 'Rotation')],
		] as const) {
			const input = h(ownerDocument, 'input', {
				properties: { type: 'number', step: 'any' },
				attributes: { 'aria-label': label },
			});
			if (field === 'width' || field === 'height') {
				input.min = '0.001';
			}
			this.geometryInputs.set(field, input);
			const fieldDomNode = h(
				ownerDocument,
				'label',
				{ className: `ash-design-property-field${field === 'rotation' ? ' ash-design-property-wide' : ''}` },
				h(ownerDocument, 'span', {}, field === 'width' ? 'W' : field === 'height' ? 'H' : label),
				input,
			);
			(field === 'width' || field === 'height' ? layout : position).append(fieldDomNode);
			this._register(
				addDisposableListener(input, 'change', () => {
					const shape = this.selectedShape;
					if (shape && input.checkValidity() && Number.isFinite(input.valueAsNumber)) {
						this.commands.updateGeometry(shape, field, input.valueAsNumber);
					} else {
						this.refresh();
					}
				}),
			);
		}
		this.appearanceProperties = this.createSection(localize('sessions.design.appearance', 'Appearance'));
		const fill = h(ownerDocument, 'div', { className: 'ash-design-property-wide ash-design-fill' }, h(ownerDocument, 'span', {}, localize('sessions.design.fill', 'Fill')));
		this.appearanceProperties.append(fill);
		this.fillDomNode = fill;
		this.fillColor = this._register(
			createDesignColorPicker(instantiation, ownerDocument, {
				color: localize('sessions.design.fill', 'Fill'),
				value: localize('sessions.design.fillColor', 'Fill color'),
				opacity: localize('sessions.design.fillOpacity', 'Fill opacity (%)'),
				getDocumentColors: () =>
					[
						...new Set(
							flattenDesignShapes(this.documentController.model.value.shapes)
								.filter(shape => (shape.kind !== 'group' || !!shape.booleanOperation) && shape.kind !== 'image')
								.flatMap(shape => designPaints(shape).flatMap(paint => (paint.type === 'solid' ? [paint.color.toLowerCase()] : paint.stops.map(stop => stop.color.toLowerCase())))),
						),
					].map(fill => Color.Format.CSS.parseHex(fill)!),
			}),
		);
		fill.append(this.fillColor.domNode);
		this._register(
			this.fillColor.onDidChangeColor(color => {
				const shape = this.selectedShape;
				if (!shape) {
					return;
				}
				this.colorPreview = withDesignPaintColor(shape, this.selection.paintId, this.selection.gradientStopId, Color.Format.CSS.formatHexA(color, true));
				this.refresh();
			}),
		);
		this._register(
			this.fillColor.onDidClose(() => {
				this.colorPreview = undefined;
				this.refresh();
			}),
		);
		this._register(this.fillColor.onDidCommitColor(color => this.commitColor(color, this.fillColor)));
		this._register(
			documentController.model.onDidChange(() => {
				if (!this.isCommittingColor) {
					this.cancel();
				}
			}),
		);
		this.paints = this._register(new PaintPropertiesWidget(documentController, commands, selection, ownerDocument, () => this.refresh(), focusCanvas));
		this.appearanceProperties.append(this.paints.domNode);
		this.effectProperties = this.createSection(localize('sessions.design.effects', 'Effects'));
		this.effects = this._register(instantiation.createInstance(EffectPropertiesWidget, documentController, commands, selection, ownerDocument, () => this.refresh(), focusCanvas));
		this.effectProperties.append(this.effects.domNode);
		this.textProperties = this.createSection(localize('sessions.design.typography', 'Typography'));
		this.typography = this._register(new TextPropertiesWidget(ownerDocument, documentController, commands, text));
		this.textProperties.append(this.typography.domNode);
		this.pathProperties = this.createSection(localize('sessions.design.path', 'Bézier path'));
		this.strokeWidthInput = h(ownerDocument, 'input', {
			properties: { type: 'number', min: '0', step: 'any' },
			attributes: { 'aria-label': localize('sessions.design.strokeWidth', 'Stroke width') },
		});
		this.pathProperties.append(h(ownerDocument, 'label', { className: 'ash-design-property-wide' }, localize('sessions.design.strokeWidth', 'Stroke width'), this.strokeWidthInput));
		this._register(
			addDisposableListener(this.strokeWidthInput, 'change', () => {
				const shape = this.selectedShape;
				if (shape?.kind === 'path' && this.strokeWidthInput.checkValidity() && Number.isFinite(this.strokeWidthInput.valueAsNumber)) {
					this.commands.updateShape({ ...shape, strokeWidth: this.strokeWidthInput.valueAsNumber });
				} else {
					this.refresh();
				}
			}),
		);
		this.nodeInput = h(ownerDocument, 'select', {
			attributes: { 'aria-label': localize('sessions.design.node', 'Path node') },
		});
		this.closedInput = h(ownerDocument, 'input', {
			properties: { type: 'checkbox' },
			attributes: { 'aria-label': localize('sessions.design.closed', 'Closed path') },
		});
		this.pathProperties.append(
			h(ownerDocument, 'label', { className: 'ash-design-property-wide' }, localize('sessions.design.node', 'Path node'), this.nodeInput),
			h(ownerDocument, 'label', { className: 'ash-design-property-toggle ash-design-property-wide' }, this.closedInput, localize('sessions.design.closed', 'Closed path')),
		);
		this._register(
			addDisposableListener(this.nodeInput, 'change', () => {
				this.selection.nodeIndex = Number(this.nodeInput.value);
				this.selection.editingVector = true;
				this.refresh();
			}),
		);
		this._register(
			addDisposableListener(this.closedInput, 'change', () => {
				const shape = this.selectedShape;
				if (shape?.kind === 'path') {
					this.commands.vector.editContour(shape, this.selection.contourIndex, contour => ({
						...contour,
						closed: this.closedInput.checked,
					}));
				}
			}),
		);
		for (const [field, label] of [
			['x', localize('sessions.design.anchorX', 'Anchor X')],
			['y', localize('sessions.design.anchorY', 'Anchor Y')],
			['incomingX', localize('sessions.design.incomingX', 'Incoming handle X')],
			['incomingY', localize('sessions.design.incomingY', 'Incoming handle Y')],
			['outgoingX', localize('sessions.design.outgoingX', 'Outgoing handle X')],
			['outgoingY', localize('sessions.design.outgoingY', 'Outgoing handle Y')],
		] as const) {
			const input = h(ownerDocument, 'input', {
				properties: { type: 'number', step: 'any' },
				attributes: { 'aria-label': label },
			});
			this.pathInputs.set(field, input);
			this.pathProperties.append(h(ownerDocument, 'label', {}, label, input));
			this._register(
				addDisposableListener(input, 'change', () => {
					const shape = this.selectedShape;
					if (shape?.kind !== 'path' || !input.checkValidity() || !Number.isFinite(input.valueAsNumber)) {
						this.refresh();
						return;
					}
					const axis = field.endsWith('X') || field === 'x' ? 'x' : 'y';
					const value = input.valueAsNumber / (axis === 'x' ? shape.width : shape.height);
					this.commands.vector.editContour(shape, this.selection.contourIndex, contour => ({
						...contour,
						nodes: contour.nodes.map((node, index) => {
							if (index !== this.selection.nodeIndex) {
								return node;
							}
							const point = field.startsWith('incoming') ? 'incoming' : field.startsWith('outgoing') ? 'outgoing' : 'anchor';
							return moveDesignPathNode(node, point, { ...(point === 'anchor' ? node : node[point]), [axis]: value }, shape.width, shape.height);
						}),
					}));
				}),
			);
		}
		this.domNode.append(this.vectorProperties.domNode);
		this.imageProperties = this.createSection(localize('sessions.design.imageCrop', 'Image crop'));
		for (const [field, label] of [
			['x', localize('sessions.design.cropX', 'Crop left (%)')],
			['y', localize('sessions.design.cropY', 'Crop top (%)')],
			['width', localize('sessions.design.cropWidth', 'Crop width (%)')],
			['height', localize('sessions.design.cropHeight', 'Crop height (%)')],
		] as const) {
			const input = h(ownerDocument, 'input', {
				properties: {
					type: 'number',
					min: field === 'width' || field === 'height' ? '0.001' : '0',
					max: '100',
					step: 'any',
				},
				attributes: { 'aria-label': label },
			});
			this.cropInputs.set(field, input);
			this.imageProperties.append(h(ownerDocument, 'label', {}, label, input));
			this._register(
				addDisposableListener(input, 'change', () => {
					const shape = this.selectedShape;
					if (shape?.kind !== 'image' || !Number.isFinite(input.valueAsNumber)) {
						this.refresh();
						return;
					}
					input.setCustomValidity('');
					const crop = { ...shape.crop, [field]: input.valueAsNumber / 100 };
					if (!input.checkValidity() || crop.x + crop.width > 1 || crop.y + crop.height > 1) {
						input.setCustomValidity(localize('sessions.design.cropOutside', 'Keep the crop inside the original image.'));
						input.reportValidity();
						this.refresh();
						return;
					}
					this.commands.updateShape({ ...shape, crop });
				}),
			);
		}
		this.frameProperties = h(ownerDocument, 'div', {
			className: 'ash-design-frame-properties ash-design-property-wide',
		});
		this.clipInput = h(ownerDocument, 'input', {
			properties: { type: 'checkbox' },
			attributes: { 'aria-label': localize('sessions.design.clip', 'Clip contents') },
		});
		this.frameProperties.append(h(ownerDocument, 'label', { className: 'ash-design-property-toggle' }, this.clipInput, localize('sessions.design.clip', 'Clip contents')));
		this._register(
			addDisposableListener(this.clipInput, 'change', () => {
				const shape = this.selectedShape;
				if (shape?.kind === 'frame') {
					this.commands.updateShape({ ...shape, clip: this.clipInput.checked });
				}
			}),
		);
		layout.append(this.frameProperties);
		this.autoLayoutProperties = this.createSection(localize('sessions.design.autoLayout', 'Auto layout'));
		this.autoLayoutFields = h(ownerDocument, 'div', {
			className: 'ash-design-layout-fields ash-design-property-wide',
		});
		this.autoLayoutProperties.append(this.autoLayoutFields);
		this.addSelect(
			this.autoLayoutProperties,
			localize('sessions.design.layoutFlow', 'Layout flow'),
			[
				['none', localize('sessions.design.freeLayout', 'Free layout')],
				['horizontal', localize('sessions.design.horizontal', 'Horizontal')],
				['vertical', localize('sessions.design.vertical', 'Vertical')],
				['grid', localize('sessions.design.gridLayout', 'Grid')],
			],
			() => (this.selectedShape?.kind === 'frame' ? (this.selectedShape.autoLayout?.direction ?? 'none') : 'none'),
			value => {
				const frame = this.selectedShape;
				if (frame?.kind !== 'frame') {
					return;
				}
				if (value === 'none') {
					const { autoLayout: _layout, ...free } = frame;
					this.commands.updateShape(free);
				} else if (frame.autoLayout) {
					this.updateAutoLayout({
						...frame.autoLayout,
						direction: value,
						...(value === 'grid' ? { wrap: false, grid: frame.autoLayout.grid ?? this.defaultGrid() } : {}),
					});
				} else {
					this.updateAutoLayout({
						direction: value,
						...(value === 'grid' ? { grid: this.defaultGrid() } : {}),
						gap: 12,
						padding: { top: 12, right: 12, bottom: 12, left: 12 },
						align: 'start',
						justify: 'start',
						width: 'fixed',
						height: 'fixed',
					});
				}
			},
		);
		this.autoLayoutProperties.append(this.autoLayoutFields);
		for (const [axis, label] of [
			['width', localize('sessions.design.frameWidthSizing', 'Frame width sizing')],
			['height', localize('sessions.design.frameHeightSizing', 'Frame height sizing')],
		] as const) {
			this.addSelect(
				this.autoLayoutFields,
				label,
				[
					['fixed', localize('sessions.design.fixed', 'Fixed')],
					['hug', localize('sessions.design.hug', 'Hug contents')],
				],
				() => (this.selectedShape?.kind === 'frame' ? (this.selectedShape.autoLayout?.[axis] ?? 'fixed') : 'fixed'),
				value => {
					const frame = this.selectedShape;
					if (frame?.kind === 'frame' && frame.autoLayout) {
						this.updateAutoLayout({ ...frame.autoLayout, [axis]: value }, axis);
					}
				},
			);
		}
		const alignmentOptions = [
			['start', localize('sessions.design.start', 'Start')],
			['center', localize('sessions.design.center', 'Center')],
			['end', localize('sessions.design.end', 'End')],
		] as const;
		const crossAlignment = this.addSelect(
			this.autoLayoutFields,
			localize('sessions.design.crossAlignment', 'Cross-axis alignment'),
			alignmentOptions,
			() => (this.selectedShape?.kind === 'frame' ? (this.selectedShape.autoLayout?.align ?? 'start') : 'start'),
			value => {
				const frame = this.selectedShape;
				if (frame?.kind === 'frame' && frame.autoLayout) {
					this.updateAutoLayout({ ...frame.autoLayout, align: value });
				}
			},
		);
		const mainAlignment = this.addSelect(
			this.autoLayoutFields,
			localize('sessions.design.mainAlignment', 'Main-axis alignment'),
			[...alignmentOptions, ['space-between', localize('sessions.design.spaceBetween', 'Space between')]],
			() => (this.selectedShape?.kind === 'frame' ? (this.selectedShape.autoLayout?.justify ?? 'start') : 'start'),
			value => {
				const frame = this.selectedShape;
				if (frame?.kind === 'frame' && frame.autoLayout) {
					this.updateAutoLayout({ ...frame.autoLayout, justify: value });
				}
			},
		);
		const wrap = this.addSelect(
			this.autoLayoutFields,
			localize('sessions.design.wrap', 'Wrap'),
			[
				['none', localize('sessions.design.noWrap', 'No wrap')],
				['wrap', localize('sessions.design.wrap', 'Wrap')],
			],
			() => (this.selectedLayout?.wrap ? 'wrap' : 'none'),
			value => {
				const current = this.selectedLayout;
				if (current && current.direction !== 'grid') {
					this.updateAutoLayout({ ...current, wrap: value === 'wrap' });
				}
			},
		);
		this.layoutRefresh.push(() => {
			for (const select of [crossAlignment, mainAlignment, wrap]) {
				select.parentElement!.hidden = this.selectedLayout?.direction === 'grid';
			}
		});
		const crossGap = this.addNumber(
			this.autoLayoutFields,
			localize('sessions.design.lineGap', 'Line gap'),
			() => this.selectedLayout?.crossGap ?? this.selectedLayout?.gap ?? 0,
			value => {
				if (this.selectedLayout && value !== undefined) {
					this.updateAutoLayout({ ...this.selectedLayout, crossGap: value });
				}
			},
			0,
		);
		this.layoutRefresh.push(() => {
			crossGap.parentElement!.hidden = !this.selectedLayout?.wrap && this.selectedLayout?.direction !== 'grid';
			const label = this.selectedLayout?.direction === 'grid' ? localize('sessions.design.rowGap', 'Row gap') : localize('sessions.design.lineGap', 'Line gap');
			crossGap.setAttribute('aria-label', label);
			crossGap.parentElement!.firstChild!.textContent = label;
		});
		for (const [field, label] of [
			['gap', localize('sessions.design.gap', 'Gap')],
			['top', localize('sessions.design.paddingTop', 'Padding top')],
			['right', localize('sessions.design.paddingRight', 'Padding right')],
			['bottom', localize('sessions.design.paddingBottom', 'Padding bottom')],
			['left', localize('sessions.design.paddingLeft', 'Padding left')],
		] as const) {
			const input = h(ownerDocument, 'input', {
				properties: { type: 'number', step: 'any' },
				attributes: { 'aria-label': label },
			});
			this.autoLayoutFields.append(h(ownerDocument, 'label', {}, label, input));
			this._register(
				addDisposableListener(input, 'change', () => {
					const frame = this.selectedShape;
					if (frame?.kind === 'frame' && frame.autoLayout && !this.documentController.isBusy && input.checkValidity() && Number.isFinite(input.valueAsNumber)) {
						this.updateAutoLayout(
							field === 'gap'
								? { ...frame.autoLayout, gap: input.valueAsNumber }
								: {
										...frame.autoLayout,
										padding: { ...frame.autoLayout.padding, [field]: input.valueAsNumber },
									},
						);
					} else {
						this.refresh();
					}
				}),
			);
			this.layoutRefresh.push(() => {
				const frame = this.selectedShape;
				if (field === 'gap') {
					const text = frame?.kind === 'frame' && frame.autoLayout?.direction === 'grid' ? localize('sessions.design.columnGap', 'Column gap') : label;
					input.setAttribute('aria-label', text);
					input.parentElement!.firstChild!.textContent = text;
				}
				input.value = String(frame?.kind === 'frame' && frame.autoLayout ? (field === 'gap' ? frame.autoLayout.gap : frame.autoLayout.padding[field]) : 0);
				input.disabled = this.documentController.isBusy;
			});
		}
		this.sizingProperties = this.createSection(localize('sessions.design.childSizing', 'Child sizing'));
		for (const [axis, label] of [
			['width', localize('sessions.design.widthSizing', 'Width sizing')],
			['height', localize('sessions.design.heightSizing', 'Height sizing')],
		] as const) {
			this.addSelect(
				this.sizingProperties,
				label,
				[
					['fixed', localize('sessions.design.fixed', 'Fixed')],
					['fill', localize('sessions.design.fillContainer', 'Fill container')],
				],
				() => this.selectedShape?.sizing?.[axis] ?? 'fixed',
				value => {
					const shape = this.selectedShape;
					const parent = this.selectedParent;
					if (!shape || shape.kind === 'group' || !parent?.autoLayout) {
						return;
					}
					const updated = {
						...shape,
						sizing: { width: 'fixed' as const, height: 'fixed' as const, ...shape.sizing, [axis]: value },
					};
					const updates: DesignShape[] = [updated.kind === 'frame' && updated.autoLayout ? { ...updated, autoLayout: { ...updated.autoLayout, [axis]: 'fixed' } } : updated];
					if (value === 'fill') {
						updates.push({ ...parent, autoLayout: { ...parent.autoLayout, [axis]: 'fixed' } });
					}
					this.commands.updateShapes(updates);
				},
			);
		}
		this.gridProperties = this.createSection(localize('sessions.design.gridTracks', 'Grid tracks'));
		this.createGridControls();
		this.gridCellProperties = this.createSection(localize('sessions.design.gridCell', 'Grid cell'));
		this.createGridCellControls(alignmentOptions);
		this.limitsProperties = this.createSection(localize('sessions.design.sizeLimits', 'Size limits'));
		this.createSizeLimitControls();
		this.constraintsProperties = this.createSection(localize('sessions.design.constraints', 'Constraints'));
		for (const [axis, label, start, end, stretch] of [
			[
				'horizontal',
				localize('sessions.design.horizontalConstraint', 'Horizontal constraint'),
				localize('sessions.design.left', 'Left'),
				localize('sessions.design.right', 'Right'),
				localize('sessions.design.leftRight', 'Left and right'),
			],
			[
				'vertical',
				localize('sessions.design.verticalConstraint', 'Vertical constraint'),
				localize('sessions.design.top', 'Top'),
				localize('sessions.design.bottom', 'Bottom'),
				localize('sessions.design.topBottom', 'Top and bottom'),
			],
		] as const) {
			const select = this.addSelect<DesignConstraint>(
				this.constraintsProperties,
				label,
				[
					['start', start],
					['center', localize('sessions.design.center', 'Center')],
					['end', end],
					['stretch', stretch],
					['scale', localize('sessions.design.scale', 'Scale')],
				],
				() => this.selectedShape?.constraints?.[axis] ?? 'start',
				value => {
					const shape = this.selectedShape;
					if (shape && !(shape.kind === 'group' && (value === 'stretch' || value === 'scale'))) {
						this.commands.updateShape({
							...shape,
							constraints: {
								horizontal: 'start',
								vertical: 'start',
								...shape.constraints,
								[axis]: value,
							},
						});
					}
				},
			);
			this.layoutRefresh.push(() => {
				for (const option of select.options) {
					option.disabled = this.selectedShape?.kind === 'group' && (option.value === 'stretch' || option.value === 'scale');
				}
			});
		}
		const guide = h(
			ownerDocument,
			'section',
			{
				className: 'ash-design-property-section',
				attributes: { 'aria-label': localize('sessions.design.layoutGuide', 'Layout guide') },
			},
			h(ownerDocument, 'h3', {}, localize('sessions.design.layoutGuide', 'Layout guide')),
			h(ownerDocument, 'div', { className: 'ash-design-guide-row' }, localize('sessions.design.gridSize', 'Grid · {0} px', 12)),
		);
		this.exportFormatInput = h(
			ownerDocument,
			'select',
			{ attributes: { 'aria-label': localize('sessions.design.exportFormat', 'Export format') } },
			h(ownerDocument, 'option', { properties: { value: 'svg' } }, 'SVG'),
			h(ownerDocument, 'option', { properties: { value: 'html' } }, 'HTML'),
		);
		const exportRow = h(ownerDocument, 'div', { className: 'ash-design-export-row' }, this.exportFormatInput);
		this.exportButton = this._register(
			new Button(exportRow, {
				...defaultButtonStyles,
				label: localize('sessions.design.exportDesign', 'Export design'),
				onClick: () => {
					void this.exportDesign(this.exportFormatInput.value as 'svg' | 'html');
				},
			}),
		);
		this.domNode.append(
			guide,
			h(
				ownerDocument,
				'section',
				{
					className: 'ash-design-property-section',
					attributes: { 'aria-label': localize('sessions.design.exportSection', 'Export') },
				},
				h(ownerDocument, 'h3', {}, localize('sessions.design.exportSection', 'Export')),
				exportRow,
			),
		);
	}

	public get background(): string {
		return this.pageColorPreview ?? this.documentController.model.value.background ?? '#ffffff';
	}

	public get preview(): DesignShape | undefined {
		return this.vectorProperties.preview ?? this.colorPreview;
	}

	public cancel(): void {
		this.vectorProperties.cancel();
		ColorPicker.cancelPickers(this.domNode);
	}

	private commitColor(color: Color, target: ColorPicker): void {
		const shape = this.selectedShape;
		const isPage = target === this.pageColor;
		if (this.documentController.isBusy || (isPage ? this.selection.ids.size > 0 : !shape)) {
			return;
		}
		const fill = Color.Format.CSS.formatHexA(color, true);
		this.colorPreview = undefined;
		this.pageColorPreview = undefined;
		if (fill.toLowerCase() === (isPage ? (this.documentController.model.value.background ?? '#ffffff') : this.paints.color).toLowerCase()) {
			this.refresh();
			return;
		}
		this.isCommittingColor = true;
		try {
			if (isPage) {
				this.commands.setBackground(fill);
			} else {
				this.commands.updateShape(withDesignPaintColor(shape!, this.selection.paintId, this.selection.gradientStopId, fill));
			}
		} finally {
			this.isCommittingColor = false;
		}
	}

	private renderFill(fill: string): void {
		this.fillColor.setColor(Color.Format.CSS.parseHex(fill)!, `${this.selectedShape?.id}:${this.paints.paint?.id}:${this.selection.gradientStopId}`);
	}

	private createSection(title: string): HTMLElement {
		const ownerDocument = this.domNode.ownerDocument;
		const section = h(ownerDocument, 'details', {
			className: 'ash-design-property-section',
			properties: { open: true },
		});
		const summary = h(
			ownerDocument,
			'summary',
			{},
			title,
			h(ownerDocument, 'span', {
				className: 'ash-design-property-disclosure',
				attributes: { 'aria-hidden': 'true' },
			}),
		);
		const body = h(ownerDocument, 'div', {
			className: 'ash-design-property-fields',
			attributes: { role: 'group', 'aria-label': title },
		});
		section.append(summary, body);
		this.domNode.append(section);
		return body;
	}

	private get selectedParent(): Extract<DesignShape, { kind: 'frame' }> | undefined {
		const entry = getDesignShapeEntries(this.documentController.model.value.shapes).find(entry => entry.shape.id === this.selectedShape?.id);
		return entry?.parent?.kind === 'frame' ? entry.parent : undefined;
	}

	private updateAutoLayout(autoLayout: DesignAutoLayout, sizingAxis?: 'width' | 'height'): void {
		const frame = this.selectedShape;
		if (frame?.kind !== 'frame') {
			return;
		}
		// Hug owns this dimension; remove competing fill settings in the same edit.
		const children = frame.children.map(child =>
			child.sizing
				? {
						...child,
						sizing: {
							width: autoLayout.width === 'hug' ? ('fixed' as const) : child.sizing.width,
							height: autoLayout.height === 'hug' ? ('fixed' as const) : child.sizing.height,
						},
					}
				: child,
		);
		this.commands.updateShape({
			...frame,
			autoLayout,
			children,
			...(sizingAxis && frame.sizing ? { sizing: { ...frame.sizing, [sizingAxis]: 'fixed' } } : {}),
		});
	}

	private get selectedLayout(): DesignAutoLayout | undefined {
		const shape = this.selectedShape;
		return shape?.kind === 'frame' ? shape.autoLayout : undefined;
	}

	private defaultGrid(): DesignGrid {
		return {
			columns: [
				{ sizing: 'fill', value: 1 },
				{ sizing: 'fill', value: 1 },
			],
			rows: [{ sizing: 'fill', value: 1 }],
			autoRows: true,
			positioning: 'auto',
		};
	}

	private updateGrid(grid: DesignGrid): void {
		const frame = this.selectedShape;
		if (frame?.kind !== 'frame' || !frame.autoLayout) {
			return;
		}
		// Removing tracks preserves objects, clamps spans and moves manual anchors into
		// the remaining grid. The layout owner then relocates any colliding cells.
		const children = frame.children.map(child => {
			if (!child.gridCell) {
				return child;
			}
			const cell = { ...child.gridCell };
			if (grid.columns.length < (frame.autoLayout!.grid?.columns.length ?? 0)) {
				if (cell.columnSpan !== undefined) {
					cell.columnSpan = Math.min(cell.columnSpan, grid.columns.length);
				}
				if (cell.column !== undefined) {
					cell.column = Math.min(cell.column, grid.columns.length - (cell.columnSpan ?? 1) + 1);
				}
			}
			if (!grid.autoRows && (frame.autoLayout!.grid?.autoRows || grid.rows.length < (frame.autoLayout!.grid?.rows.length ?? 0))) {
				if (cell.rowSpan !== undefined) {
					cell.rowSpan = Math.min(cell.rowSpan, grid.rows.length);
				}
				if (cell.row !== undefined) {
					cell.row = Math.min(cell.row, grid.rows.length - (cell.rowSpan ?? 1) + 1);
				}
			}
			return { ...child, gridCell: cell };
		});
		this.commands.updateShape({ ...frame, children, autoLayout: { ...frame.autoLayout, grid } });
	}

	private createGridControls(): void {
		const container = this.gridProperties;
		const ownerDocument = this.domNode.ownerDocument;
		for (const [axis, label] of [
			['columns', localize('sessions.design.gridColumns', 'Columns')],
			['rows', localize('sessions.design.gridRows', 'Rows')],
		] as const) {
			const count = this.addNumber(
				container,
				label,
				() => {
					const grid = this.selectedLayout?.grid;
					return axis === 'rows' && grid?.autoRows ? undefined : (grid?.[axis].length ?? 1);
				},
				value => {
					const grid = this.selectedLayout?.grid;
					if (!grid) {
						return;
					}
					const tracks = value === undefined ? grid[axis] : Array.from({ length: value }, (_, index) => grid[axis][index] ?? ({ sizing: 'fill', value: 1 } as const));
					this.updateGrid({
						...grid,
						[axis]: tracks,
						...(axis === 'rows' ? { autoRows: value === undefined } : {}),
					});
				},
				1,
				axis === 'rows',
				true,
				1000,
			);
			if (axis === 'rows') {
				count.placeholder = localize('sessions.design.automatic', 'Auto');
			}
		}
		this.addSelect(
			container,
			localize('sessions.design.gridPositioning', 'Cell positioning'),
			[
				['auto', localize('sessions.design.automatic', 'Auto')],
				['manual', localize('sessions.design.manual', 'Manual')],
			],
			() => this.selectedLayout?.grid?.positioning ?? 'auto',
			value => {
				const frame = this.selectedShape;
				const grid = this.selectedLayout?.grid;
				if (frame?.kind !== 'frame' || !grid) {
					return;
				}
				const cells = getDesignGridCells(frame.children, grid);
				const children =
					value === 'manual'
						? frame.children.map((child, index) => ({
								...child,
								gridCell: {
									...child.gridCell,
									column: cells[index].column + 1,
									row: cells[index].row + 1,
								},
							}))
						: frame.children;
				this.commands.updateShape({
					...frame,
					children,
					autoLayout: {
						...frame.autoLayout!,
						grid: { ...grid, positioning: value, ...(value === 'auto' ? { autoRows: true } : {}) },
					},
				});
			},
		);
		for (const [axis, label, trackLabel, sizingLabel, valueLabel] of [
			[
				'columns',
				localize('sessions.design.gridColumns', 'Columns'),
				localize('sessions.design.columnTrack', 'Column track'),
				localize('sessions.design.columnSizing', 'Column sizing'),
				localize('sessions.design.columnValue', 'Column pixels / fraction'),
			],
			[
				'rows',
				localize('sessions.design.gridRows', 'Rows'),
				localize('sessions.design.rowTrack', 'Row track'),
				localize('sessions.design.rowSizing', 'Row sizing'),
				localize('sessions.design.rowValue', 'Row pixels / fraction'),
			],
		] as const) {
			const fields = h(ownerDocument, 'div', {
				className: 'ash-design-layout-fields ash-design-property-wide',
				attributes: { role: 'group', 'aria-label': label },
			});
			container.append(fields);
			const indexSelect = h(ownerDocument, 'select', { attributes: { 'aria-label': trackLabel } });
			fields.append(h(ownerDocument, 'label', { className: 'ash-design-property-wide' }, trackLabel, indexSelect));
			let selectedIndex = 0;
			let frameId: string | undefined;
			const track = (): DesignGridTrack => this.selectedLayout?.grid?.[axis][selectedIndex] ?? { sizing: 'fill', value: 1 };
			const change = (track: DesignGridTrack): void => {
				const grid = this.selectedLayout?.grid;
				if (!grid) {
					return;
				}
				const tracks = Array.from({ length: Math.max(grid[axis].length, selectedIndex + 1) }, (_, index) =>
					index === selectedIndex ? track : (grid[axis][index] ?? ({ sizing: 'fill', value: 1 } as const)),
				);
				this.updateGrid({ ...grid, [axis]: tracks });
			};
			this._register(
				addDisposableListener(indexSelect, 'change', () => {
					selectedIndex = indexSelect.selectedIndex;
					this.refresh();
				}),
			);
			this.layoutRefresh.push(() => {
				const frame = this.selectedShape;
				const grid = this.selectedLayout?.grid;
				if (frameId !== frame?.id) {
					selectedIndex = 0;
					frameId = frame?.id;
				}
				const count = grid
					? axis === 'rows' && grid.autoRows && frame?.kind === 'frame'
						? Math.max(1, ...getDesignGridCells(frame.children, grid).map(cell => cell.row + cell.rowSpan))
						: grid[axis].length
					: 1;
				selectedIndex = Math.min(Math.max(0, selectedIndex), count - 1);
				if (indexSelect.options.length !== count) {
					indexSelect.replaceChildren(...Array.from({ length: count }, (_, index) => h(ownerDocument, 'option', { properties: { value: String(index) } }, String(index + 1))));
				}
				indexSelect.selectedIndex = selectedIndex;
				indexSelect.disabled = this.documentController.isBusy;
			});
			this.addSelect(
				fields,
				sizingLabel,
				[
					['fixed', localize('sessions.design.fixed', 'Fixed')],
					['hug', localize('sessions.design.hug', 'Hug contents')],
					['fill', localize('sessions.design.fillContainer', 'Fill container')],
				],
				() => track().sizing,
				value => {
					change(value === 'hug' ? { sizing: 'hug' } : { sizing: value, value: value === 'fill' ? 1 : 100 });
				},
			);
			const input = this.addNumber(
				fields,
				valueLabel,
				() => {
					const current = track();
					return current.sizing === 'hug' ? undefined : current.value;
				},
				value => {
					const current = track();
					if (current.sizing !== 'hug' && value !== undefined) {
						change({ ...current, value });
					}
				},
				0.001,
			);
			this.layoutRefresh.push(() => {
				input.parentElement!.hidden = track().sizing === 'hug';
			});
		}
	}

	private createGridCellControls(alignments: readonly (readonly ['start' | 'center' | 'end', string])[]): void {
		for (const [field, label] of [
			['column', localize('sessions.design.cellColumn', 'Column')],
			['row', localize('sessions.design.cellRow', 'Row')],
			['columnSpan', localize('sessions.design.columnSpan', 'Column span')],
			['rowSpan', localize('sessions.design.rowSpan', 'Row span')],
		] as const) {
			const input = this.addNumber(
				this.gridCellProperties,
				label,
				() => this.selectedShape?.gridCell?.[field] ?? 1,
				value => {
					const shape = this.selectedShape;
					if (!shape || value === undefined) {
						return;
					}
					const axis = field === 'columnSpan' ? 'width' : field === 'rowSpan' ? 'height' : undefined;
					let updated: DesignShape = { ...shape, gridCell: { ...shape.gridCell, [field]: value } };
					if (axis && value > 1 && shape.kind !== 'group') {
						updated = {
							...updated,
							sizing: { width: 'fixed', height: 'fixed', ...shape.sizing, [axis]: 'fill' },
						};
						if (updated.kind === 'frame' && updated.autoLayout) {
							updated = { ...updated, autoLayout: { ...updated.autoLayout, [axis]: 'fixed' } };
						}
					}
					this.commands.updateShape(updated);
				},
				1,
				false,
				true,
				1000,
			);
			this.layoutRefresh.push(() => {
				const grid = this.selectedParent?.autoLayout?.grid;
				input.parentElement!.hidden = (field === 'column' || field === 'row') && grid?.positioning !== 'manual';
				if (field === 'column' || field === 'columnSpan') {
					input.max = String(grid?.columns.length ?? 1000);
				}
				if (field.endsWith('Span')) {
					input.disabled ||= this.selectedShape?.kind === 'group';
				}
			});
		}
		for (const [axis, label] of [
			['horizontal', localize('sessions.design.cellHorizontalAlignment', 'Horizontal cell alignment')],
			['vertical', localize('sessions.design.cellVerticalAlignment', 'Vertical cell alignment')],
		] as const) {
			this.addSelect(
				this.gridCellProperties,
				label,
				alignments,
				() => this.selectedShape?.gridCell?.[axis] ?? 'start',
				value => {
					const shape = this.selectedShape;
					if (shape) {
						this.commands.updateShape({ ...shape, gridCell: { ...shape.gridCell, [axis]: value } });
					}
				},
			);
		}
	}

	private createSizeLimitControls(): void {
		for (const [field, label, opposite] of [
			['minWidth', localize('sessions.design.minWidth', 'Min width'), 'maxWidth'],
			['maxWidth', localize('sessions.design.maxWidth', 'Max width'), 'minWidth'],
			['minHeight', localize('sessions.design.minHeight', 'Min height'), 'maxHeight'],
			['maxHeight', localize('sessions.design.maxHeight', 'Max height'), 'minHeight'],
		] as const) {
			this.addNumber(
				this.limitsProperties,
				label,
				() => this.selectedShape?.sizeLimits?.[field],
				value => {
					const shape = this.selectedShape;
					if (!shape || shape.kind === 'group') {
						return;
					}
					const other = shape.sizeLimits?.[opposite];
					if (value !== undefined && other !== undefined && (field.startsWith('min') ? value > other : value < other)) {
						return localize('sessions.design.sizeLimitsOrder', 'Minimum must not exceed maximum.');
					}
					const sizeLimits = { ...shape.sizeLimits };
					if (value === undefined) {
						delete sizeLimits[field];
					} else {
						sizeLimits[field] = value;
					}
					const { sizeLimits: _limits, ...rest } = shape;
					this.commands.updateShape({
						...rest,
						...(Object.keys(sizeLimits).length ? { sizeLimits } : {}),
						...(shape.kind === 'text' && field === 'maxHeight' && value !== undefined ? { maxLines: undefined } : {}),
					});
				},
				field.startsWith('min') ? 0 : 0.001,
				true,
			);
		}
	}

	private addNumber(
		container: HTMLElement,
		label: string,
		value: () => number | undefined,
		change: (value: number | undefined) => void | string,
		min: number,
		optional = false,
		integer = false,
		max?: number,
	): HTMLInputElement {
		const input = h(this.domNode.ownerDocument, 'input', {
			properties: { type: 'number', min: String(min), step: integer ? '1' : 'any', required: !optional },
			attributes: { 'aria-label': label },
		});
		if (max !== undefined) {
			input.max = String(max);
		}
		if (optional) {
			input.placeholder = localize('sessions.design.noLimit', 'None');
		}
		container.append(h(this.domNode.ownerDocument, 'label', {}, label, input));
		this._register(
			addDisposableListener(input, 'input', () => {
				input.setCustomValidity('');
				input.removeAttribute('aria-invalid');
			}),
		);
		this._register(
			addDisposableListener(input, 'change', () => {
				if (this.documentController.isBusy) {
					return;
				}
				input.setCustomValidity('');
				const next = optional && input.value === '' ? undefined : input.valueAsNumber;
				if (!input.checkValidity() || (next !== undefined && (!Number.isFinite(next) || (integer && !Number.isInteger(next))))) {
					input.setAttribute('aria-invalid', 'true');
					input.reportValidity();
					return;
				}
				const error = change(next);
				if (error) {
					input.setCustomValidity(error);
					input.setAttribute('aria-invalid', 'true');
					input.reportValidity();
				} else {
					this.refresh();
				}
			}),
		);
		this.layoutRefresh.push(() => {
			const current = value();
			input.value = current === undefined ? '' : String(current);
			input.disabled = this.documentController.isBusy;
			input.setCustomValidity('');
			input.removeAttribute('aria-invalid');
		});
		return input;
	}

	private addSelect<T extends string>(container: HTMLElement, label: string, options: readonly (readonly [T, string])[], value: () => T, change: (value: T) => void): HTMLSelectElement {
		const select = h(
			this.domNode.ownerDocument,
			'select',
			{ attributes: { 'aria-label': label } },
			...options.map(([value, text]) => h(this.domNode.ownerDocument, 'option', { properties: { value } }, text)),
		);
		container.append(h(this.domNode.ownerDocument, 'label', {}, label, select));
		this._register(
			addDisposableListener(select, 'change', () => {
				const option = options.find(([value]) => value === select.value);
				if (option && !this.documentController.isBusy) {
					change(option[0]);
				}
			}),
		);
		this.layoutRefresh.push(() => {
			select.value = value();
			select.disabled = this.documentController.isBusy;
		});
		return select;
	}

	private get selectedShape(): DesignShape | undefined {
		return this.selection.ids.size === 1 ? flattenDesignShapes(this.documentController.model.value.shapes).find(shape => this.selection.ids.has(shape.id)) : undefined;
	}

	public getActions(): readonly IAction[] {
		const shape = this.selectedShape;
		if (shape?.kind !== 'path' || this.commands.components.isInstanceChild(shape.id)) {
			return this.vectorProperties.getActions().filter(action => action.enabled);
		}
		return [
			...this.vectorProperties.getActions().filter(action => action.enabled),
			{
				id: 'sessions.design.addNode',
				label: localize('sessions.design.addNode', 'Add node'),
				tooltip: localize('sessions.design.addNode', 'Add node'),
				enabled: !this.documentController.isBusy,
				run: () => this.addPathNode(),
			},
			{
				id: 'sessions.design.removeNode',
				label: localize('sessions.design.removeNode', 'Remove node'),
				tooltip: localize('sessions.design.removeNode', 'Remove node'),
				enabled: !this.documentController.isBusy && this.selection.nodeIndices.size > 0,
				run: () => this.removePathNode(),
			},
		];
	}

	public focus(): void {
		if (!this.selectedShape) {
			this.headingDomNode.focus();
			return;
		}
		this.positionSection.open = true;
		if (this.geometryInputs.get('x')!.disabled) {
			this.layoutSection.open = true;
			this.geometryInputs.get('width')!.focus();
		} else {
			this.geometryInputs.get('x')!.focus();
		}
	}

	public update(shape: DesignShape | undefined, isVisible: boolean): void {
		this.componentProperties.update();
		this.resourceProperties.update();
		this.vectorProperties.update();
		this.paints.update();
		this.effects.update();
		if (!isVisible || this.documentController.isBusy) {
			this.cancel();
		}
		this.domNode.classList.toggle('visible', isVisible);
		this.pageDomNode.hidden = this.selection.ids.size > 0;
		this.pageColor.setColor(Color.Format.CSS.parseHex(this.documentController.model.value.background ?? '#ffffff')!, this.documentController.model.value.documentId);
		this.pageColor.enabled = !this.documentController.isBusy && this.selection.ids.size === 0;
		if (!shape) {
			this.fillColor.enabled = false;
		}
		this.nameInput.closest('details')!.hidden = !shape;
		this.nameInput.value = shape?.name ?? '';
		this.nameInput.disabled = this.documentController.isBusy;
		this.arrangementProperties.parentElement!.hidden = this.selection.ids.size === 0;
		for (const { button, enabled } of this.arrangementButtons) {
			button.enabled = !this.documentController.isBusy && enabled();
		}
		this.autoLayoutProperties.parentElement!.hidden = shape?.kind !== 'frame';
		this.autoLayoutFields.hidden = shape?.kind !== 'frame' || !shape.autoLayout;
		const parent = this.selectedParent;
		const inherited = !!shape && this.commands.components.isInstanceChild(shape.id);
		const paintParent = shape && getDesignShapeEntries(this.documentController.model.value.shapes).find(entry => entry.shape.id === shape.id)?.parent;
		const booleanChild = paintParent?.kind === 'group' && !!paintParent.booleanOperation;
		this.constraintsProperties.parentElement!.hidden = !shape || !parent || (!!parent.autoLayout && shape.layoutPositioning !== 'absolute') || this.commands.components.isInstanceChild(shape.id);
		this.sizingProperties.parentElement!.hidden = !shape || shape.kind === 'group' || !parent?.autoLayout || shape.layoutPositioning === 'absolute' || inherited;
		this.gridProperties.parentElement!.hidden = this.selectedLayout?.direction !== 'grid';
		this.gridCellProperties.parentElement!.hidden = parent?.autoLayout?.direction !== 'grid' || shape?.layoutPositioning === 'absolute' || inherited;
		this.limitsProperties.parentElement!.hidden = !shape || shape.kind === 'group' || !(this.selectedLayout || parent?.autoLayout || shape.sizeLimits);
		for (const refresh of this.layoutRefresh) {
			refresh();
		}
		this.positionSection.hidden = this.layoutSection.hidden = !shape;
		this.exportButton.enabled = !this.documentController.isBusy && this.documentController.model.value.shapes.length > 0;
		this.exportFormatInput.disabled = !this.exportButton.enabled;
		this.effectProperties.parentElement!.hidden = !shape;
		this.appearanceProperties.parentElement!.hidden = !shape;
		this.fillDomNode.hidden = !shape || (shape.kind === 'group' && !shape.booleanOperation) || shape.kind === 'image' || !this.paints.paint;
		this.textProperties.parentElement!.hidden = shape?.kind !== 'text';
		if (shape?.kind !== 'text') {
			this.typography.update(undefined);
		}
		this.pathProperties.parentElement!.hidden = shape?.kind !== 'path';
		this.imageProperties.parentElement!.hidden = shape?.kind !== 'image';
		this.frameProperties.hidden = shape?.kind !== 'frame';
		if (!shape) {
			this.headingDomNode.textContent =
				this.selection.ids.size > 1 ? localize('sessions.design.selectionCount', '{0} objects selected.', this.selection.ids.size) : localize('sessions.design.page', 'Page');
			return;
		}
		const titles: Record<DesignShape['kind'], string> = {
			rectangle: localize('sessions.design.rectangle', 'Rectangle'),
			ellipse: localize('sessions.design.ellipse', 'Ellipse'),
			text: localize('sessions.design.text', 'Text'),
			path: localize('sessions.design.path', 'Bézier path'),
			group: localize('sessions.design.group', 'Group'),
			frame: localize('sessions.design.frame', 'Frame'),
			image: localize('sessions.design.image', 'Image'),
		};
		this.headingDomNode.textContent = shape.name || titles[shape.kind];
		for (const field of ['x', 'y', 'width', 'height', 'rotation'] as const) {
			const input = this.geometryInputs.get(field)!;
			input.value = `${shape[field]}`;
			input.disabled =
				this.documentController.isBusy ||
				((field === 'x' || field === 'y') && !!parent?.autoLayout && shape.layoutPositioning !== 'absolute') ||
				(inherited && (field === 'x' || field === 'y' || field === 'rotation' || shape.kind === 'text'));
		}
		this.renderFill(this.paints.color);
		this.fillColor.enabled = !booleanChild && !this.documentController.isBusy && (shape.kind !== 'group' || !!shape.booleanOperation) && shape.kind !== 'image';
		if (shape.kind === 'frame') {
			this.clipInput.checked = shape.clip;
			this.clipInput.disabled = this.documentController.isBusy || !!shape.instance || inherited;
		}
		if (shape.kind === 'image') {
			for (const [field, input] of this.cropInputs) {
				input.value = `${shape.crop[field] * 100}`;
				input.disabled = this.documentController.isBusy;
				input.setCustomValidity('');
			}
		}
		this.typography.update(shape.kind === 'text' ? shape : undefined);
		if (shape.kind === 'path') {
			this.strokeWidthInput.value = `${shape.strokeWidth}`;
			this.strokeWidthInput.disabled = this.documentController.isBusy;
			const contour = designPathEditingContours(shape)[this.selection.contourIndex];
			if (this.selection.nodeIndex >= contour.nodes.length) {
				this.selection.nodeIndex = contour.nodes.length - 1;
			}
			if (this.nodeInput.options.length !== contour.nodes.length) {
				this.nodeInput.replaceChildren(...contour.nodes.map((_, index) => h(this.domNode.ownerDocument, 'option', { properties: { value: `${index}` } }, `${index + 1}`)));
			}
			this.nodeInput.value = `${this.selection.nodeIndex}`;
			this.closedInput.checked = contour.closed;
			this.nodeInput.disabled = this.closedInput.disabled = this.documentController.isBusy || inherited;
			this.closedInput.disabled ||= !!shape.network;
			const node = contour.nodes[this.selection.nodeIndex];
			for (const [field, input] of this.pathInputs) {
				const axis = field.endsWith('X') || field === 'x' ? 'x' : 'y';
				let point: DesignPoint = node;
				if (field.startsWith('incoming')) {
					point = node.incoming;
				}
				if (field.startsWith('outgoing')) {
					point = node.outgoing;
				}
				const dimension = axis === 'x' ? shape.width : shape.height;
				input.value = `${point[axis] * dimension}`;
				input.removeAttribute('max');
				input.disabled = this.documentController.isBusy || inherited || (!!shape.network && field !== 'x' && field !== 'y');
			}
		}
	}

	private addPathNode(): void {
		const shape = this.selectedShape;
		if (shape?.kind !== 'path' || this.documentController.isBusy) {
			return;
		}
		if (shape.network) {
			const edge = shape.network.edges.findIndex(edge => edge.start === this.selection.nodeIndex || edge.end === this.selection.nodeIndex);
			if (edge >= 0) {
				this.selection.nodeIndex = shape.network.vertices.length;
				this.commands.vector.insertNode(shape, edge, 0);
			}
			return;
		}
		const contour = designPathEditingContours(shape)[this.selection.contourIndex];
		const index = Math.min(this.selection.nodeIndex, contour.nodes.length - (contour.closed ? 1 : 2));
		this.selection.nodeIndex = index + 1;
		this.commands.vector.insertNode(shape, this.selection.contourIndex, index);
	}

	private removePathNode(): void {
		const shape = this.selectedShape;
		if (shape?.kind !== 'path' || !this.selection.nodeIndices.size || this.documentController.isBusy) {
			return;
		}
		this.commands.vector.removeNodes(shape, this.selection.contourIndex, this.selection.nodeIndices);
	}

	protected override disposeCore(): void {
		this.cancel();
		super.disposeCore();
	}
}
