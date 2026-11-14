import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { ColorPicker } from '../../../../base/browser/ui/colorPicker/colorPicker.js';
import { Color } from '../../../../base/common/color.js';
import type { Icon } from '../../../../base/common/icon.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { createUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';

type AnnotationShape = 'rectangle' | 'ellipse' | 'line';
type AnnotationTool = 'shape' | 'arrow' | 'pen' | 'text';

export class ScreenshotAnnotationControls extends Disposable {
	readonly element: HTMLElement;
	private readonly geometryGroup: HTMLElement;
	private readonly fillGroup: HTMLElement;
	private readonly colors: HTMLElement;
	private readonly sizeInput: HTMLInputElement;
	private readonly sizeValue: HTMLOutputElement;
	private readonly colorDialog: HTMLDialogElement;
	private readonly customColor: Button;
	private readonly swatches = new Map<string, Button>();
	private readonly shapes = new Map<AnnotationShape, Button>();
	private readonly fill: Button;
	private readonly outline: Button;
	private tool: AnnotationTool = 'shape';
	private strokeWidth = 4;
	private fontSize = 24;
	private ink = '#ef4444';
	private shape: AnnotationShape = 'rectangle';
	private filled = false;

	constructor(document: Document) {
		super();
		this.element = h(document, 'div', { className: 'ash-screenshot-options', attributes: { role: 'group', 'aria-label': localize('screenshot.annotationOptions', 'Annotation options') } });
		this.element.id = `screenshot-options-${createUuid()}`;
		const group = (container: HTMLElement) => {
			const group = h(document, 'div', { className: 'ash-screenshot-option-group' });
			container.append(group);
			return group;
		};
		const button = (container: HTMLElement, label: string, onClick: () => void, icon?: Icon) => {
			const control = this._register(new Button(container, { label: '', ariaLabel: label, iconOnly: true, icon, onClick }));
			control.domNode.title = label;
			control.domNode.classList.add('ash-screenshot-icon-button');
			return control;
		};
		this.geometryGroup = group(this.element);
		this.fillGroup = group(this.element);
		const shapes = [
			['rectangle', localize('screenshot.rectangle', 'Rectangle'), Lxicon.square],
			['ellipse', localize('screenshot.ellipse', 'Ellipse'), Lxicon.circle],
			['line', localize('screenshot.line', 'Line'), Lxicon.remove],
		] as const;
		for (const [shape, label, icon] of shapes) {
			this.shapes.set(shape, button(this.geometryGroup, label, () => {
				this.shape = shape;
				this.render();
			}, icon));
		}
		const setFilled = (filled: boolean) => { this.filled = filled; this.render(); };
		this.outline = button(this.fillGroup, localize('screenshot.outline', 'Outline'), () => setFilled(false), Lxicon.circleSmallFilled);
		this.fill = button(this.fillGroup, localize('screenshot.fill', 'Fill'), () => setFilled(true), Lxicon.primitiveSquareFilled);

		const size = group(this.element);
		this.sizeInput = h(document, 'input', { className: 'ash-screenshot-size-slider', attributes: { type: 'range', step: '1' } });
		this.sizeValue = h(document, 'output', { className: 'ash-screenshot-size-value', attributes: { 'aria-hidden': 'true' } });
		size.append(this.sizeInput, this.sizeValue);
		this._register(addDisposableListener(this.sizeInput, 'input', () => {
			if (this.tool === 'text') this.fontSize = this.sizeInput.valueAsNumber;
			else this.strokeWidth = this.sizeInput.valueAsNumber;
			this.renderSize();
		}));

		this.colors = group(this.element);
		this.colors.setAttribute('role', 'group');
		this.colors.setAttribute('aria-label', localize('screenshot.color', 'Annotation color'));
		const palette = [
			['#ef4444', localize('screenshot.color.red', 'Red')],
			['#facc15', localize('screenshot.color.yellow', 'Yellow')],
			['#22c55e', localize('screenshot.color.green', 'Green')],
			['#3b82f6', localize('screenshot.color.blue', 'Blue')],
			['#ffffff', localize('screenshot.color.white', 'White')],
			['#808080', localize('screenshot.color.gray', 'Gray')],
			['#000000', localize('screenshot.color.black', 'Black')],
		] as const;
		for (const [color, label] of palette) {
			const control = button(this.colors, label, () => this.setColor(color));
			control.domNode.append(h(document, 'span', { className: 'ash-screenshot-color-swatch', attributes: { 'aria-hidden': 'true' }, style: { backgroundColor: color } }));
			this.swatches.set(color, control);
		}
		this.customColor = button(this.colors, localize('screenshot.customColor', 'Custom color'), () => {
			picker.setColor(Color.Format.CSS.parseHex(this.ink)!);
			this.colorDialog.showModal();
			this.customColor.domNode.setAttribute('aria-expanded', 'true');
			picker.focus();
		});
		const rainbow = h(document, 'span', { className: 'ash-screenshot-color-swatch', attributes: { 'aria-hidden': 'true' } });
		rainbow.style.backgroundImage = `conic-gradient(${palette.slice(0, 4).map(([color]) => color).join(', ')}, ${palette[0][0]})`;
		this.customColor.domNode.append(rainbow);
		this.customColor.domNode.setAttribute('aria-haspopup', 'dialog');
		this.customColor.domNode.setAttribute('aria-expanded', 'false');
		this.colorDialog = h(document, 'dialog', { className: 'ash-screenshot-color-dialog', attributes: { 'aria-label': localize('screenshot.customColor', 'Custom color') } });
		const picker = this._register(new ColorPicker(document));
		this.colorDialog.append(picker.domNode);
		this.element.append(this.colorDialog);
		this._register(picker.onDidCommitColor(color => this.setColor(Color.Format.CSS.formatHexA(color, true))));
		this._register(picker.onDidRequestClose(() => this.colorDialog.close()));
		this._register(addDisposableListener(this.colorDialog, 'close', () => {
			this.customColor.domNode.setAttribute('aria-expanded', 'false');
			if (!this.element.hidden) this.customColor.focus();
		}));
		this.render();
	}

	get drawingShape(): AnnotationShape { return this.shape; }
	get fillShape(): boolean { return this.shape !== 'line' && this.filled; }
	get color(): string { return this.ink; }
	get width(): number { return this.strokeWidth; }
	get textSize(): number { return this.fontSize; }
	get colorPickerOpen(): boolean { return this.colorDialog.open; }

	focus(): void {
		if (this.tool === 'shape') this.shapes.get(this.shape)!.focus();
		else this.sizeInput.focus();
	}

	show(tool: string): void {
		this.element.hidden = tool !== 'shape' && tool !== 'arrow' && tool !== 'pen' && tool !== 'text';
		switch (tool) {
			case 'shape': case 'arrow': case 'pen': case 'text':
				this.tool = tool;
				this.render();
		}
	}

	private setColor(color: string): void {
		this.ink = color;
		for (const [value, control] of this.swatches) control.checked = value === color;
		this.customColor.checked = !this.swatches.has(color);
	}

	private render(): void {
		this.geometryGroup.hidden = this.tool !== 'shape';
		this.fillGroup.hidden = this.tool !== 'shape';
		this.colors.hidden = this.tool === 'text';
		for (const [shape, control] of this.shapes) control.checked = this.shape === shape;
		this.outline.enabled = this.fill.enabled = this.shape !== 'line';
		this.outline.checked = !this.fillShape;
		this.fill.checked = this.fillShape;
		const text = this.tool === 'text';
		this.sizeInput.setAttribute('aria-label', text ? localize('screenshot.fontSize', 'Font size') : localize('screenshot.lineWidth', 'Line width'));
		this.sizeInput.min = text ? '12' : '1';
		this.sizeInput.max = text ? '72' : '24';
		this.sizeInput.value = String(text ? this.fontSize : this.strokeWidth);
		this.sizeInput.disabled = this.tool === 'shape' && this.fillShape;
		this.renderSize();
		this.setColor(this.ink);
	}

	private renderSize(): void {
		const value = localize('screenshot.linePixels', '{0} px', this.sizeInput.valueAsNumber);
		this.sizeValue.value = value;
		this.sizeInput.setAttribute('aria-valuetext', value);
	}
}
