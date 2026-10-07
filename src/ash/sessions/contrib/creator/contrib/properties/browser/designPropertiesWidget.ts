import './designPropertiesWidget.css';
import { addDisposableListener, h } from '../../../../../../base/browser/dom.js';
import { Button } from '../../../../../../base/browser/ui/button/button.js';
import { ColorPicker } from '../../../../../../base/browser/ui/colorPicker/colorPicker.js';
import { Color, RGBA } from '../../../../../../base/common/color.js';
import { ContextViewFocusRestore, ContextViewHideReason } from '../../../../../../base/browser/ui/contextview/contextview.js';
import { IContextViewService } from '../../../../../../platform/contextview/browser/contextView.js';
import { IContextKeyService } from '../../../../../../platform/contextkey/browser/contextKeyService.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { AccessibilityVerbositySettingId } from '../../../../../../platform/accessibility/browser/accessibleView.js';
import type { IAction } from '../../../../../../base/common/actions.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../nls.js';
import type { DesignPoint } from '../../../common/core/geometry.js';
import type { DocumentCommands } from '../../../common/commands/documentCommands.js';
import type { DesignDocumentController } from '../../../browser/designDocumentController.js';
import { flattenDesignShapes, type DesignImageCrop, type DesignShape } from '../../../common/model/document.js';
import type { DesignSelection } from '../../../common/selection.js';

type GeometryField = 'x' | 'y' | 'width' | 'height' | 'rotation';

/** Owns geometry, text and path-property controls; edits use the shared document history. */
export class DesignPropertiesWidget extends Disposable {
	public readonly domNode: HTMLElement;
	private readonly headingDomNode: HTMLElement;
	private readonly pageDomNode: HTMLElement;
	private readonly pageNameDomNode: HTMLElement;
	private readonly pageSummaryDomNode: HTMLElement;
	private readonly positionSection: HTMLDetailsElement;
	private readonly layoutSection: HTMLDetailsElement;
	private readonly geometryInputs = new Map<GeometryField, HTMLInputElement>();
	private readonly appearanceProperties: HTMLElement;
	private readonly fillButton: Button;
	private readonly fillSwatchDomNode: HTMLElement;
	private readonly fillOpacityInput: HTMLInputElement;
	private readonly exportButton: Button;
	private readonly exportFormatInput: HTMLSelectElement;
	private readonly colorPicker: ColorPicker;
	private pickerVisible = false;
	private pickerShapeId: string | undefined;
	private isCommittingColor = false;
	private colorPreview: DesignShape | undefined;
	private readonly recentColors: string[] = [];
	private readonly textProperties: HTMLElement;
	private readonly textInput: HTMLTextAreaElement;
	private readonly fontSizeInput: HTMLInputElement;
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
		@IContextViewService private readonly contextViews: IContextViewService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IConfigurationService private readonly configuration: IConfigurationService,
	) {
		super();
		this.domNode = h(ownerDocument, 'div', { className: 'ash-sessions-design-properties', attributes: { role: 'group', 'aria-label': localize('sessions.design.properties', 'Shape properties') } });
		this.headingDomNode = h(ownerDocument, 'h2', { className: 'ash-design-properties-heading', attributes: { tabindex: '-1' } });
		this.domNode.append(this.headingDomNode);
		this.pageNameDomNode = h(ownerDocument, 'span', { className: 'ash-design-page-name' });
		this.pageSummaryDomNode = h(ownerDocument, 'p', { className: 'ash-design-page-summary' });
		this.pageDomNode = h(ownerDocument, 'div', { className: 'ash-design-page-properties' }, this.pageNameDomNode, this.pageSummaryDomNode);
		this.domNode.append(this.pageDomNode);
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
			const input = h(ownerDocument, 'input', { properties: { type: 'number', step: 'any' }, attributes: { 'aria-label': label } });
			if (field === 'width' || field === 'height') { input.min = '0.001'; }
			this.geometryInputs.set(field, input);
			const fieldDomNode = h(ownerDocument, 'label', { className: `ash-design-property-field${field === 'rotation' ? ' ash-design-property-wide' : ''}` }, h(ownerDocument, 'span', {}, field === 'width' ? 'W' : field === 'height' ? 'H' : label), input);
			(field === 'width' || field === 'height' ? layout : position).append(fieldDomNode);
			this._register(addDisposableListener(input, 'change', () => {
				const shape = this.selectedShape;
				if (shape && input.checkValidity() && Number.isFinite(input.valueAsNumber)) {
					this.commands.updateGeometry(shape, field, input.valueAsNumber);
				} else { this.refresh(); }
			}));
		}
		this.appearanceProperties = this.createSection(localize('sessions.design.appearance', 'Appearance'));
		const fill = h(ownerDocument, 'div', { className: 'ash-design-property-wide ash-design-fill' }, h(ownerDocument, 'span', {}, localize('sessions.design.fill', 'Fill')));
		this.appearanceProperties.append(fill);
		const fillRow = h(ownerDocument, 'div', { className: 'ash-design-fill-row' });
		fill.append(fillRow);
		this.fillButton = this._register(new Button(fillRow, { label: '', ariaLabel: localize('sessions.design.fill', 'Fill'), onClick: () => this.openColorPicker() }));
		this.fillButton.domNode.setAttribute('aria-haspopup', 'dialog');
		this.fillButton.domNode.setAttribute('aria-expanded', 'false');
		this.fillSwatchDomNode = h(ownerDocument, 'span', { className: 'ash-design-fill-swatch', attributes: { 'aria-hidden': 'true' } });
		this.fillButton.domNode.prepend(this.fillSwatchDomNode);
		this.fillOpacityInput = h(ownerDocument, 'input', { attributes: { type: 'number', min: '0', max: '100', step: '0.1', 'aria-label': localize('sessions.design.fillOpacity', 'Fill opacity (%)') } });
		fillRow.append(h(ownerDocument, 'label', { className: 'ash-design-fill-opacity' }, this.fillOpacityInput, h(ownerDocument, 'span', {}, '%')));
		this._register(addDisposableListener(this.fillOpacityInput, 'change', () => {
			const shape = this.selectedShape;
			if (!shape || !this.fillOpacityInput.value || !this.fillOpacityInput.checkValidity()) { this.refresh(); return; }
			const { r, g, b } = Color.Format.CSS.parseHex(shape.fill)!.rgba;
			this.commitColor(new Color(new RGBA(r, g, b, this.fillOpacityInput.valueAsNumber / 100)));
		}));
		this.colorPicker = this._register(new ColorPicker(ownerDocument));
		this._register(contextKeys.createScoped(this.colorPicker.domNode)).createKey('sessionsDesignColorPickerFocused', true);
		this._register(this.colorPicker.onDidChangeColor(color => {
			const shape = this.selectedShape;
			if (!shape) { return; }
			this.colorPreview = { ...shape, fill: Color.Format.CSS.formatHexA(color, true) };
			this.renderFill(this.colorPreview.fill);
			this.refresh();
		}));
		this._register(this.colorPicker.onDidCommitColor(color => this.commitColor(color)));
		this._register(this.colorPicker.onDidRequestClose(() => {
			this.commitColor(this.colorPicker.color);
			this.cancel();
		}));
		this._register(documentController.model.onDidChange(() => {
			if (!this.isCommittingColor) { this.cancel(); }
		}));
		this.textProperties = this.createSection(localize('sessions.design.typography', 'Typography'));
		this.textInput = h(ownerDocument, 'textarea', { attributes: { 'aria-label': localize('sessions.design.textContent', 'Text content'), rows: '2' } });
		this.fontSizeInput = h(ownerDocument, 'input', { properties: { type: 'number', min: '0.001', step: 'any' }, attributes: { 'aria-label': localize('sessions.design.fontSize', 'Font size') } });
		this.textProperties.append(h(ownerDocument, 'label', { className: 'ash-design-property-wide' }, localize('sessions.design.textContent', 'Text content'), this.textInput), h(ownerDocument, 'label', {}, localize('sessions.design.fontSize', 'Font size'), this.fontSizeInput));
		this._register(addDisposableListener(this.textInput, 'change', () => {
			const shape = this.selectedShape;
			if (shape?.kind === 'text') { this.commands.updateShape({ ...shape, text: this.textInput.value }); }
		}));
		this._register(addDisposableListener(this.fontSizeInput, 'change', () => {
			const shape = this.selectedShape;
			if (shape?.kind === 'text' && this.fontSizeInput.checkValidity() && Number.isFinite(this.fontSizeInput.valueAsNumber)) { this.commands.updateShape({ ...shape, fontSize: this.fontSizeInput.valueAsNumber }); }
			else { this.refresh(); }
		}));
		this.pathProperties = this.createSection(localize('sessions.design.path', 'Bézier path'));
		this.strokeWidthInput = h(ownerDocument, 'input', { properties: { type: 'number', min: '0.001', step: 'any' }, attributes: { 'aria-label': localize('sessions.design.strokeWidth', 'Stroke width') } });
		this.pathProperties.append(h(ownerDocument, 'label', { className: 'ash-design-property-wide' }, localize('sessions.design.strokeWidth', 'Stroke width'), this.strokeWidthInput));
		this._register(addDisposableListener(this.strokeWidthInput, 'change', () => {
			const shape = this.selectedShape;
			if (shape?.kind === 'path' && this.strokeWidthInput.checkValidity() && Number.isFinite(this.strokeWidthInput.valueAsNumber)) {
				this.commands.updateShape({ ...shape, strokeWidth: this.strokeWidthInput.valueAsNumber });
			} else { this.refresh(); }
		}));
		this.nodeInput = h(ownerDocument, 'select', { attributes: { 'aria-label': localize('sessions.design.node', 'Path node') } });
		this.closedInput = h(ownerDocument, 'input', { properties: { type: 'checkbox' }, attributes: { 'aria-label': localize('sessions.design.closed', 'Closed path') } });
		this.pathProperties.append(h(ownerDocument, 'label', { className: 'ash-design-property-wide' }, localize('sessions.design.node', 'Path node'), this.nodeInput), h(ownerDocument, 'label', { className: 'ash-design-property-toggle ash-design-property-wide' }, this.closedInput, localize('sessions.design.closed', 'Closed path')));
		this._register(addDisposableListener(this.nodeInput, 'change', () => { this.selection.nodeIndex = Number(this.nodeInput.value); this.refresh(); }));
		this._register(addDisposableListener(this.closedInput, 'change', () => {
			const shape = this.selectedShape;
			if (shape?.kind === 'path') { this.commands.updateShape({ ...shape, closed: this.closedInput.checked }); }
		}));
		for (const [field, label] of [
			['x', localize('sessions.design.anchorX', 'Anchor X')], ['y', localize('sessions.design.anchorY', 'Anchor Y')],
			['incomingX', localize('sessions.design.incomingX', 'Incoming handle X')], ['incomingY', localize('sessions.design.incomingY', 'Incoming handle Y')],
			['outgoingX', localize('sessions.design.outgoingX', 'Outgoing handle X')], ['outgoingY', localize('sessions.design.outgoingY', 'Outgoing handle Y')],
		] as const) {
			const input = h(ownerDocument, 'input', { properties: { type: 'number', min: '0', step: 'any' }, attributes: { 'aria-label': label } });
			this.pathInputs.set(field, input);
			this.pathProperties.append(h(ownerDocument, 'label', {}, label, input));
			this._register(addDisposableListener(input, 'change', () => {
				const shape = this.selectedShape;
				if (shape?.kind !== 'path' || !input.checkValidity() || !Number.isFinite(input.valueAsNumber)) { this.refresh(); return; }
				const axis = field.endsWith('X') || field === 'x' ? 'x' : 'y';
				const value = input.valueAsNumber / (axis === 'x' ? shape.width : shape.height);
				const nodes = shape.nodes.map((node, index) => {
					if (index !== this.selection.nodeIndex) { return node; }
					if (field.startsWith('incoming')) { return { ...node, incoming: { ...node.incoming, [axis]: value } }; }
					if (field.startsWith('outgoing')) { return { ...node, outgoing: { ...node.outgoing, [axis]: value } }; }
					return { ...node, [axis]: value };
				});
				this.commands.updateShape({ ...shape, nodes });
			}));
		}
		this.imageProperties = this.createSection(localize('sessions.design.imageCrop', 'Image crop'));
		for (const [field, label] of [
			['x', localize('sessions.design.cropX', 'Crop left (%)')],
			['y', localize('sessions.design.cropY', 'Crop top (%)')],
			['width', localize('sessions.design.cropWidth', 'Crop width (%)')],
			['height', localize('sessions.design.cropHeight', 'Crop height (%)')],
		] as const) {
			const input = h(ownerDocument, 'input', { properties: { type: 'number', min: field === 'width' || field === 'height' ? '0.001' : '0', max: '100', step: 'any' }, attributes: { 'aria-label': label } });
			this.cropInputs.set(field, input);
			this.imageProperties.append(h(ownerDocument, 'label', {}, label, input));
			this._register(addDisposableListener(input, 'change', () => {
				const shape = this.selectedShape;
				if (shape?.kind !== 'image' || !Number.isFinite(input.valueAsNumber)) { this.refresh(); return; }
				input.setCustomValidity('');
				const crop = { ...shape.crop, [field]: input.valueAsNumber / 100 };
				if (!input.checkValidity() || crop.x + crop.width > 1 || crop.y + crop.height > 1) {
					input.setCustomValidity(localize('sessions.design.cropOutside', 'Keep the crop inside the original image.'));
					input.reportValidity(); this.refresh(); return;
				}
				this.commands.updateShape({ ...shape, crop });
			}));
		}
		this.frameProperties = h(ownerDocument, 'div', { className: 'ash-design-frame-properties ash-design-property-wide' });
		this.clipInput = h(ownerDocument, 'input', { properties: { type: 'checkbox' }, attributes: { 'aria-label': localize('sessions.design.clip', 'Clip contents') } });
		this.frameProperties.append(h(ownerDocument, 'label', { className: 'ash-design-property-toggle' }, this.clipInput, localize('sessions.design.clip', 'Clip contents')));
		this._register(addDisposableListener(this.clipInput, 'change', () => {
			const shape = this.selectedShape;
			if (shape?.kind === 'frame') { this.commands.updateShape({ ...shape, clip: this.clipInput.checked }); }
		}));
		layout.append(this.frameProperties);
		const guide = h(ownerDocument, 'section', { className: 'ash-design-property-section', attributes: { 'aria-label': localize('sessions.design.layoutGuide', 'Layout guide') } }, h(ownerDocument, 'h3', {}, localize('sessions.design.layoutGuide', 'Layout guide')), h(ownerDocument, 'div', { className: 'ash-design-guide-row' }, localize('sessions.design.gridSize', 'Grid · {0} px', 12)));
		this.exportFormatInput = h(ownerDocument, 'select', { attributes: { 'aria-label': localize('sessions.design.exportFormat', 'Export format') } }, h(ownerDocument, 'option', { properties: { value: 'svg' } }, 'SVG'), h(ownerDocument, 'option', { properties: { value: 'html' } }, 'HTML'));
		const exportRow = h(ownerDocument, 'div', { className: 'ash-design-export-row' }, this.exportFormatInput);
		this.exportButton = this._register(new Button(exportRow, { label: localize('sessions.design.exportDesign', 'Export design'), onClick: () => { void this.exportDesign(this.exportFormatInput.value as 'svg' | 'html'); } }));
		this.domNode.append(guide, h(ownerDocument, 'section', { className: 'ash-design-property-section', attributes: { 'aria-label': localize('sessions.design.exportSection', 'Export') } }, h(ownerDocument, 'h3', {}, localize('sessions.design.exportSection', 'Export')), exportRow));
	}

	public get preview(): DesignShape | undefined { return this.colorPreview; }

	public cancel(): void {
		if (this.pickerVisible) { this.contextViews.hide(); }
	}

	private openColorPicker(): void {
		const shape = this.selectedShape;
		if (!shape || this.documentController.isBusy) { return; }
		if (this.pickerVisible) { this.commitColor(this.colorPicker.color); this.cancel(); return; }
		this.colorPicker.setColor(Color.Format.CSS.parseHex(shape.fill)!);
		this.colorPicker.setPalettes([
			{ label: localize('sessions.design.documentColors', 'Document colors'), colors: [...new Set(flattenDesignShapes(this.documentController.model.value.shapes).filter(shape => shape.kind !== 'group' && shape.kind !== 'image').map(shape => shape.fill.toLowerCase()))].map(fill => Color.Format.CSS.parseHex(fill)!) },
			{ label: localize('sessions.design.recentColors', 'Recent colors'), colors: this.recentColors.map(fill => Color.Format.CSS.parseHex(fill)!) },
		]);
		const title = localize('colorPicker.title', 'Color picker');
		this.colorPicker.domNode.setAttribute('aria-label', this.configuration.getValue<boolean>(AccessibilityVerbositySettingId.DesignCanvas) ? `${title}. ${localize('sessions.design.colorHelpHint', 'Press Alt+F1 for color picker help.')}` : title);
		this.pickerVisible = true;
		this.pickerShapeId = shape.id;
		this.fillButton.domNode.setAttribute('aria-expanded', 'true');
		this.contextViews.show({
			anchor: this.fillButton.domNode,
			content: this.colorPicker.domNode,
			presentation: 'dialog',
			focusRestore: ContextViewFocusRestore.Previous,
			onHide: reason => {
				if (reason === ContextViewHideReason.OutsidePointer) { this.commitColor(this.colorPicker.color); }
				this.pickerVisible = false;
				this.pickerShapeId = undefined;
				this.colorPreview = undefined;
				const shape = this.selectedShape;
				if (shape) { this.colorPicker.setColor(Color.Format.CSS.parseHex(shape.fill)!); }
				this.fillButton.domNode.setAttribute('aria-expanded', 'false');
				if (!this.isDisposed) { this.refresh(); }
			},
		});
		this.colorPicker.focus();
	}

	private commitColor(color: Color): void {
		const shape = this.selectedShape;
		if (!shape || this.documentController.isBusy) { return; }
		const fill = Color.Format.CSS.formatHexA(color, true);
		this.colorPreview = undefined;
		if (fill.toLowerCase() === shape.fill.toLowerCase()) { this.refresh(); return; }
		this.isCommittingColor = true;
		try { this.commands.updateShape({ ...shape, fill }); }
		finally { this.isCommittingColor = false; }
		const index = this.recentColors.indexOf(fill);
		if (index >= 0) { this.recentColors.splice(index, 1); }
		this.recentColors.unshift(fill);
		this.recentColors.length = Math.min(this.recentColors.length, 16);
	}

	private renderFill(fill: string): void {
		const color = Color.Format.CSS.parseHex(fill)!;
		this.fillButton.label = Color.Format.CSS.formatHex(color).slice(1).toUpperCase();
		this.fillOpacityInput.value = `${Math.round(color.rgba.a * 1000) / 10}`;
		this.fillSwatchDomNode.style.setProperty('--ash-design-fill', fill);
	}

	private createSection(title: string): HTMLElement {
		const ownerDocument = this.domNode.ownerDocument;
		const section = h(ownerDocument, 'details', { className: 'ash-design-property-section', properties: { open: true } });
		const summary = h(ownerDocument, 'summary', {}, title, h(ownerDocument, 'span', { className: 'ash-design-property-disclosure', attributes: { 'aria-hidden': 'true' } }));
		const body = h(ownerDocument, 'div', { className: 'ash-design-property-fields', attributes: { role: 'group', 'aria-label': title } });
		section.append(summary, body);
		this.domNode.append(section);
		return body;
	}

	private get selectedShape(): DesignShape | undefined {
		return this.selection.ids.size === 1 ? flattenDesignShapes(this.documentController.model.value.shapes).find(shape => this.selection.ids.has(shape.id)) : undefined;
	}

	public getActions(): readonly IAction[] {
		const shape = this.selectedShape;
		if (shape?.kind !== 'path') { return []; }
		return [
			{ id: 'sessions.design.addNode', label: localize('sessions.design.addNode', 'Add node'), tooltip: localize('sessions.design.addNode', 'Add node'), enabled: !this.documentController.isBusy, run: () => this.addPathNode() },
			{ id: 'sessions.design.removeNode', label: localize('sessions.design.removeNode', 'Remove node'), tooltip: localize('sessions.design.removeNode', 'Remove node'), enabled: !this.documentController.isBusy && shape.nodes.length > 2, run: () => this.removePathNode() },
		];
	}

	public focus(): void {
		if (!this.selectedShape) { this.headingDomNode.focus(); return; }
		this.positionSection.open = true;
		this.geometryInputs.get('x')!.focus();
	}

	public update(shape: DesignShape | undefined, isVisible: boolean): void {
		if (!shape || !isVisible || this.documentController.isBusy || (this.pickerVisible && shape.id !== this.pickerShapeId)) { this.cancel(); }
		this.domNode.classList.toggle('visible', isVisible);
		this.pageDomNode.hidden = !!shape;
		this.positionSection.hidden = this.layoutSection.hidden = !shape;
		this.exportButton.enabled = !this.documentController.isBusy && this.documentController.model.value.shapes.length > 0;
		this.exportFormatInput.disabled = !this.exportButton.enabled;
		this.appearanceProperties.parentElement!.hidden = !shape || shape.kind === 'group' || shape.kind === 'image';
		this.textProperties.parentElement!.hidden = shape?.kind !== 'text';
		this.pathProperties.parentElement!.hidden = shape?.kind !== 'path';
		this.imageProperties.parentElement!.hidden = shape?.kind !== 'image';
		this.frameProperties.hidden = shape?.kind !== 'frame';
		if (!shape) {
			this.headingDomNode.textContent = this.selection.ids.size > 1 ? localize('sessions.design.selectionCount', '{0} objects selected.', this.selection.ids.size) : localize('sessions.design.page', 'Page');
			this.pageNameDomNode.textContent = this.documentController.name;
			this.pageSummaryDomNode.textContent = this.selection.ids.size > 1 ? localize('sessions.design.propertiesEmpty', 'Select one object to edit its properties.') : localize('sessions.design.objectCount', '{0} objects', flattenDesignShapes(this.documentController.model.value.shapes).length);
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
		this.headingDomNode.textContent = titles[shape.kind];
		for (const field of ['x', 'y', 'width', 'height', 'rotation'] as const) {
			const input = this.geometryInputs.get(field)!;
			input.value = `${shape[field]}`;
			input.disabled = this.documentController.isBusy;
		}
		this.renderFill(this.colorPreview?.fill ?? shape.fill);
		this.fillButton.enabled = !this.documentController.isBusy && shape.kind !== 'group' && shape.kind !== 'image';
		this.fillOpacityInput.disabled = !this.fillButton.enabled;
		if (shape.kind === 'frame') { this.clipInput.checked = shape.clip; this.clipInput.disabled = this.documentController.isBusy; }
		if (shape.kind === 'image') {
			for (const [field, input] of this.cropInputs) {
				input.value = `${shape.crop[field] * 100}`;
				input.disabled = this.documentController.isBusy;
				input.setCustomValidity('');
			}
		}
		if (shape.kind === 'text') {
			this.textInput.value = shape.text;
			this.fontSizeInput.value = `${shape.fontSize}`;
			this.textInput.disabled = this.fontSizeInput.disabled = this.documentController.isBusy;
		}
		if (shape.kind === 'path') {
			this.strokeWidthInput.value = `${shape.strokeWidth}`;
			this.strokeWidthInput.disabled = this.documentController.isBusy;
			this.selection.nodeIndex = Math.min(this.selection.nodeIndex, shape.nodes.length - 1);
			if (this.nodeInput.options.length !== shape.nodes.length) {
				this.nodeInput.replaceChildren(...shape.nodes.map((_, index) => h(this.domNode.ownerDocument, 'option', { properties: { value: `${index}` } }, `${index + 1}`)));
			}
			this.nodeInput.value = `${this.selection.nodeIndex}`;
			this.closedInput.checked = shape.closed;
			this.nodeInput.disabled = this.closedInput.disabled = this.documentController.isBusy;
			const node = shape.nodes[this.selection.nodeIndex];
			for (const [field, input] of this.pathInputs) {
				const axis = field.endsWith('X') || field === 'x' ? 'x' : 'y';
				let point: DesignPoint = node;
				if (field.startsWith('incoming')) { point = node.incoming; }
				if (field.startsWith('outgoing')) { point = node.outgoing; }
				const dimension = axis === 'x' ? shape.width : shape.height;
				input.value = `${point[axis] * dimension}`;
				input.max = `${dimension}`;
				input.disabled = this.documentController.isBusy;
			}
		}
	}

	private addPathNode(): void {
		const shape = this.selectedShape;
		if (shape?.kind !== 'path' || this.documentController.isBusy) { return; }
		this.selection.nodeIndex = shape.nodes.length;
		this.commands.updateShape({ ...shape, nodes: [...shape.nodes, { x: 1, y: 1, incoming: { x: 0.75, y: 1 }, outgoing: { x: 1, y: 1 } }] });
	}

	private removePathNode(): void {
		const shape = this.selectedShape;
		if (shape?.kind !== 'path' || shape.nodes.length <= 2 || this.documentController.isBusy) { return; }
		this.commands.updateShape({ ...shape, nodes: shape.nodes.filter((_, index) => index !== this.selection.nodeIndex) });
	}

	protected override disposeCore(): void {
		this.cancel();
		super.disposeCore();
	}

}
