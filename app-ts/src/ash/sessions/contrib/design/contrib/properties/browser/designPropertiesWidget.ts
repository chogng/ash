import './designPropertiesWidget.css';
import { addDisposableListener, h } from '../../../../../../base/browser/dom.js';
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
	private readonly geometryInputs = new Map<GeometryField, HTMLInputElement>();
	private readonly fillInput: HTMLInputElement;
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
	private readonly pathInputs = new Map<string, HTMLInputElement>();

	constructor(ownerDocument: Document, private readonly documentController: DesignDocumentController, private readonly commands: DocumentCommands, private readonly selection: DesignSelection, private readonly refresh: () => void) {
		super();
		this.domNode = h(ownerDocument, 'div', { className: 'ash-sessions-design-properties', attributes: { role: 'group', 'aria-label': localize('sessions.design.properties', 'Shape properties') } });
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
			this.domNode.append(h(ownerDocument, 'label', {}, label, input));
			this._register(addDisposableListener(input, 'change', () => {
				const shape = this.selectedShape;
				if (shape && input.checkValidity() && Number.isFinite(input.valueAsNumber)) {
					this.commands.updateGeometry(shape, field, input.valueAsNumber);
				} else { this.refresh(); }
			}));
		}
		this.fillInput = h(ownerDocument, 'input', { properties: { type: 'color' }, attributes: { 'aria-label': localize('sessions.design.fill', 'Fill') } });
		this.domNode.append(h(ownerDocument, 'label', {}, localize('sessions.design.fill', 'Fill'), this.fillInput));
		this._register(addDisposableListener(this.fillInput, 'change', () => {
			if (this.selectedShape) { this.commands.updateShape({ ...this.selectedShape, fill: this.fillInput.value }); }
		}));
		this.textProperties = h(ownerDocument, 'div', { className: 'ash-sessions-design-special-properties' });
		this.textInput = h(ownerDocument, 'textarea', { attributes: { 'aria-label': localize('sessions.design.textContent', 'Text content'), rows: '2' } });
		this.fontSizeInput = h(ownerDocument, 'input', { properties: { type: 'number', min: '0.001', step: 'any' }, attributes: { 'aria-label': localize('sessions.design.fontSize', 'Font size') } });
		this.textProperties.append(h(ownerDocument, 'label', {}, localize('sessions.design.textContent', 'Text content'), this.textInput), h(ownerDocument, 'label', {}, localize('sessions.design.fontSize', 'Font size'), this.fontSizeInput));
		this._register(addDisposableListener(this.textInput, 'change', () => {
			const shape = this.selectedShape;
			if (shape?.kind === 'text') { this.commands.updateShape({ ...shape, text: this.textInput.value }); }
		}));
		this._register(addDisposableListener(this.fontSizeInput, 'change', () => {
			const shape = this.selectedShape;
			if (shape?.kind === 'text' && this.fontSizeInput.checkValidity() && Number.isFinite(this.fontSizeInput.valueAsNumber)) { this.commands.updateShape({ ...shape, fontSize: this.fontSizeInput.valueAsNumber }); }
			else { this.refresh(); }
		}));
		this.pathProperties = h(ownerDocument, 'div', { className: 'ash-sessions-design-special-properties' });
		this.nodeInput = h(ownerDocument, 'select', { attributes: { 'aria-label': localize('sessions.design.node', 'Path node') } });
		this.closedInput = h(ownerDocument, 'input', { properties: { type: 'checkbox' }, attributes: { 'aria-label': localize('sessions.design.closed', 'Closed path') } });
		this.pathProperties.append(h(ownerDocument, 'label', {}, localize('sessions.design.node', 'Path node'), this.nodeInput), h(ownerDocument, 'label', {}, localize('sessions.design.closed', 'Closed path'), this.closedInput));
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
		this.imageProperties = h(ownerDocument, 'div', { className: 'ash-sessions-design-special-properties' });
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
		this.frameProperties = h(ownerDocument, 'div', { className: 'ash-sessions-design-special-properties' });
		this.clipInput = h(ownerDocument, 'input', { properties: { type: 'checkbox' }, attributes: { 'aria-label': localize('sessions.design.clip', 'Clip contents') } });
		this.frameProperties.append(h(ownerDocument, 'label', {}, localize('sessions.design.clip', 'Clip contents'), this.clipInput));
		this._register(addDisposableListener(this.clipInput, 'change', () => {
			const shape = this.selectedShape;
			if (shape?.kind === 'frame') { this.commands.updateShape({ ...shape, clip: this.clipInput.checked }); }
		}));
		this.domNode.append(this.textProperties, this.pathProperties, this.imageProperties, this.frameProperties);
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

	public focus(): void { this.geometryInputs.get('x')!.focus(); }

	public update(shape: DesignShape | undefined, isVisible: boolean): void {
		this.domNode.classList.toggle('visible', !!shape && isVisible);
		this.textProperties.classList.toggle('visible', shape?.kind === 'text');
		this.pathProperties.classList.toggle('visible', shape?.kind === 'path');
		this.imageProperties.classList.toggle('visible', shape?.kind === 'image');
		this.frameProperties.classList.toggle('visible', shape?.kind === 'frame');
		if (!shape) { return; }
		for (const field of ['x', 'y', 'width', 'height', 'rotation'] as const) {
			const input = this.geometryInputs.get(field)!;
			input.value = `${shape[field]}`;
			input.disabled = this.documentController.isBusy;
		}
		this.fillInput.value = shape.fill;
		this.fillInput.disabled = this.documentController.isBusy || shape.kind === 'group' || shape.kind === 'image';
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

}
