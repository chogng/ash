import './colorPicker.css';
import { addDisposableListener, h } from '../../dom.js';
import { Color, HSLA, HSVA, RGBA } from '../../../common/color.js';
import { Emitter } from '../../../common/event.js';
import { Disposable, DisposableStore } from '../../../common/lifecycle.js';
import { Button } from '../button/button.js';
import { localize } from '../../../../nls.js';

type ColorFormat = 'hex' | 'rgb' | 'css' | 'hsl' | 'hsb';
const focusedPickers = new WeakMap<HTMLElement, ColorPicker>();

/** Selects an sRGB color; the caller owns popup lifetime, palettes and committed edits. */
export class ColorPicker extends Disposable {
	public readonly domNode: HTMLElement;
	private readonly areaDomNode: HTMLElement;
	private readonly markerDomNode: HTMLElement;
	private readonly hueInput: HTMLInputElement;
	private readonly alphaInput: HTMLInputElement;
	private readonly alphaNumberInput: HTMLInputElement;
	private readonly formatInput: HTMLSelectElement;
	private readonly valueInput: HTMLInputElement;
	private readonly channelInputs: readonly HTMLInputElement[];
	private readonly channelLabels: readonly HTMLElement[];
	private readonly channelsDomNode: HTMLElement;
	private readonly valuesDomNode: HTMLElement;
	private readonly messageDomNode: HTMLElement;
	private readonly palettesDomNode: HTMLElement;
	private readonly paletteResources = this._register(new DisposableStore());
	private readonly changeEmitter = this._register(new Emitter<Color>());
	public readonly onDidChangeColor = this.changeEmitter.event;
	private readonly commitEmitter = this._register(new Emitter<Color>());
	public readonly onDidCommitColor = this.commitEmitter.event;
	private readonly closeEmitter = this._register(new Emitter<void>());
	public readonly onDidRequestClose = this.closeEmitter.event;
	private selectedColor = Color.white;
	private format: ColorFormat = 'hex';
	private gesture: { readonly pointerId: number; readonly color: Color } | undefined;
	private rangeOriginal: Color | undefined;

	constructor(ownerDocument: Document) {
		super();
		this.domNode = h(ownerDocument, 'div', { className: 'ash-color-picker', attributes: { role: 'dialog', 'aria-label': localize('colorPicker.title', 'Color picker'), 'aria-modal': 'false' } });
		focusedPickers.set(this.domNode, this);
		const heading = h(ownerDocument, 'div', { className: 'ash-color-picker-heading' }, h(ownerDocument, 'span', {}, localize('colorPicker.title', 'Color picker')));
		this._register(new Button(heading, { label: localize('colorPicker.close', 'Close'), size: 'small', onClick: () => this.closeEmitter.fire() }));
		this.markerDomNode = h(ownerDocument, 'span', { className: 'ash-color-picker-marker', attributes: { 'aria-hidden': 'true' } });
		this.areaDomNode = h(ownerDocument, 'div', { className: 'ash-color-picker-area', attributes: { role: 'slider', tabindex: '0', 'aria-label': localize('colorPicker.area', 'Saturation and brightness'), 'aria-valuemin': '0', 'aria-valuemax': '100' } }, this.markerDomNode);
		this.hueInput = h(ownerDocument, 'input', { className: 'ash-color-picker-hue', attributes: { type: 'range', min: '0', max: '360', step: '1', 'aria-label': localize('colorPicker.hue', 'Hue') } });
		this.alphaInput = h(ownerDocument, 'input', { className: 'ash-color-picker-alpha', attributes: { type: 'range', min: '0', max: '100', step: '0.1', 'aria-label': localize('colorPicker.opacity', 'Opacity') } });
		this.alphaNumberInput = h(ownerDocument, 'input', { attributes: { type: 'number', min: '0', max: '100', step: '0.1', 'aria-label': localize('colorPicker.opacityPercent', 'Opacity (%)') } });
		this.formatInput = h(ownerDocument, 'select', { attributes: { 'aria-label': localize('colorPicker.format', 'Color format') } }, ...(['hex', 'rgb', 'css', 'hsl', 'hsb'] as const).map(format => h(ownerDocument, 'option', { properties: { value: format } }, format === 'hex' ? 'Hex' : format.toUpperCase())));
		this.valueInput = h(ownerDocument, 'input', { className: 'ash-color-picker-value', attributes: { type: 'text', spellcheck: 'false', 'aria-label': localize('colorPicker.value', 'Color value') } });
		const channels = [0, 1, 2].map(() => {
			const label = h(ownerDocument, 'span');
			const input = h(ownerDocument, 'input', { attributes: { type: 'number', min: '0', step: '0.1' } });
			return { label, input, domNode: h(ownerDocument, 'label', { className: 'ash-color-picker-channel' }, input, label) };
		});
		this.channelInputs = channels.map(channel => channel.input);
		this.channelLabels = channels.map(channel => channel.label);
		this.channelsDomNode = h(ownerDocument, 'div', { className: 'ash-color-picker-channels' }, ...channels.map(channel => channel.domNode));
		this.valuesDomNode = h(ownerDocument, 'div', { className: 'ash-color-picker-values' }, this.valueInput, this.channelsDomNode);
		this.messageDomNode = h(ownerDocument, 'div', { className: 'ash-color-picker-message', attributes: { role: 'status' }, properties: { hidden: true } });
		this.palettesDomNode = h(ownerDocument, 'div', { className: 'ash-color-picker-palettes' });
		this.domNode.append(heading, this.areaDomNode, this.hueInput, h(ownerDocument, 'div', { className: 'ash-color-picker-checker' }, this.alphaInput), h(ownerDocument, 'div', { className: 'ash-color-picker-fields' }, this.formatInput, this.valuesDomNode, h(ownerDocument, 'label', { className: 'ash-color-picker-opacity' }, this.alphaNumberInput, h(ownerDocument, 'span', {}, '%'))), this.messageDomNode, this.palettesDomNode);
		this._register(addDisposableListener(this.formatInput, 'change', () => {
			this.format = this.formatInput.value as ColorFormat;
			this.render();
		}));
		for (const input of [this.hueInput, this.alphaInput]) {
			this._register(addDisposableListener(input, 'pointerdown', () => { this.rangeOriginal = this.selectedColor; }));
			this._register(addDisposableListener(input, 'input', () => {
				const { h: hue, s, v, a } = this.selectedColor.hsva;
				this.change(new Color(new HSVA(input === this.hueInput ? input.valueAsNumber : hue, s, v, input === this.alphaInput ? input.valueAsNumber / 100 : a)));
			}));
			this._register(addDisposableListener(input, 'change', () => { this.rangeOriginal = undefined; this.commitEmitter.fire(this.selectedColor); }));
			this._register(addDisposableListener(input, 'pointercancel', () => {
				if (this.rangeOriginal) { this.change(this.rangeOriginal); this.rangeOriginal = undefined; }
			}));
		}
		for (const input of [this.valueInput, this.alphaNumberInput, ...this.channelInputs]) {
			this._register(addDisposableListener(input, 'change', () => this.handleValueInput(input)));
			this._register(addDisposableListener(input, 'keydown', event => {
				if (event.key === 'Enter') { event.preventDefault(); this.handleValueInput(input); }
			}));
		}
		this._register(addDisposableListener(this.areaDomNode, 'pointerdown', event => {
			if (event.button !== 0 || this.gesture) { return; }
			event.preventDefault();
			this.areaDomNode.focus();
			this.gesture = { pointerId: event.pointerId, color: this.selectedColor };
			this.areaDomNode.setPointerCapture(event.pointerId);
			this.handlePointer(event);
		}));
		this._register(addDisposableListener(this.areaDomNode, 'pointermove', event => {
			if (this.gesture?.pointerId === event.pointerId) { this.handlePointer(event); }
		}));
		this._register(addDisposableListener(this.areaDomNode, 'pointerup', event => {
			if (this.gesture?.pointerId !== event.pointerId) { return; }
			this.handlePointer(event);
			this.gesture = undefined;
			this.areaDomNode.releasePointerCapture(event.pointerId);
			this.commitEmitter.fire(this.selectedColor);
		}));
		for (const event of ['pointercancel', 'lostpointercapture'] as const) {
			this._register(addDisposableListener(this.areaDomNode, event, () => {
				const original = this.gesture?.color;
				this.gesture = undefined;
				if (original) { this.change(original); }
			}));
		}
		this._register(addDisposableListener(this.areaDomNode, 'keydown', event => {
			const { h: hue, s, v, a } = this.selectedColor.hsva;
			const step = event.shiftKey ? 0.1 : 0.01;
			let saturation = s;
			let brightness = v;
			switch (event.key) {
				case 'ArrowLeft': saturation -= step; break;
				case 'ArrowRight': saturation += step; break;
				case 'ArrowUp': brightness += step; break;
				case 'ArrowDown': brightness -= step; break;
				case 'Home': saturation = 0; break;
				case 'End': saturation = 1; break;
				default: return;
			}
			event.preventDefault();
			this.change(new Color(new HSVA(hue, saturation, brightness, a)));
			this.commitEmitter.fire(this.selectedColor);
		}));
	}

	public get color(): Color { return this.selectedColor; }

	public static getFocused(element: HTMLElement): ColorPicker | undefined {
		const root = element.closest<HTMLElement>('.ash-color-picker');
		return root ? focusedPickers.get(root) : undefined;
	}

	public getAccessibleContent(): string {
		const { r, g, b, a } = this.color.rgba;
		const { h: hue, s, v } = this.color.hsva;
		return localize('colorPicker.description', 'Hex: {0}\nRGB: {1}, {2}, {3}\nCSS: {4}\nHSL: {5}, {6}%, {7}%\nHSB: {8}, {9}%, {10}%\nOpacity: {11}%', Color.Format.CSS.formatHexA(this.color, true), r, g, b, `rgb(${r} ${g} ${b} / ${a})`, hue, round(this.color.hsla.s * 100), round(this.color.hsla.l * 100), hue, round(s * 100), round(v * 100), round(a * 100));
	}

	public setColor(color: Color): void {
		const pointerId = this.gesture?.pointerId;
		this.gesture = undefined;
		if (pointerId !== undefined) { this.areaDomNode.releasePointerCapture(pointerId); }
		this.rangeOriginal = undefined;
		this.selectedColor = color;
		this.render();
	}

	public focus(): void { this.areaDomNode.focus(); }

	public setPalettes(palettes: readonly { readonly label: string; readonly colors: readonly Color[] }[]): void {
		this.paletteResources.clear();
		this.palettesDomNode.replaceChildren();
		for (const palette of palettes) {
			if (palette.colors.length === 0) { continue; }
			const grid = h(this.domNode.ownerDocument, 'div', { className: 'ash-color-picker-swatches', attributes: { role: 'group', 'aria-label': palette.label } });
			this.palettesDomNode.append(h(this.domNode.ownerDocument, 'div', { className: 'ash-color-picker-palette' }, h(this.domNode.ownerDocument, 'span', {}, palette.label), grid));
			for (const color of palette.colors) {
				const value = Color.Format.CSS.formatHexA(color, true).toUpperCase();
				// The color is the button's accessible name; a managed hover would replace the caller's popup.
				const button = this.paletteResources.add(new Button(grid, { label: value, ariaLabel: value, iconOnly: true, size: 'small', onClick: () => { this.change(color); this.commitEmitter.fire(color); } }));
				button.domNode.append(h(this.domNode.ownerDocument, 'span', { className: 'ash-color-picker-swatch', attributes: { 'aria-hidden': 'true' } }));
				button.domNode.style.setProperty('--ash-color-picker-value', value);
			}
			this.paletteResources.add(addDisposableListener(grid, 'keydown', event => {
				const buttons = Array.from(grid.querySelectorAll('button'));
				const index = buttons.indexOf(event.target as HTMLButtonElement);
				if (index < 0) { return; }
				let next: number;
				switch (event.key) {
					case 'ArrowLeft': case 'ArrowUp': next = (index + buttons.length - 1) % buttons.length; break;
					case 'ArrowRight': case 'ArrowDown': next = (index + 1) % buttons.length; break;
					case 'Home': next = 0; break;
					case 'End': next = buttons.length - 1; break;
					default: return;
				}
				event.preventDefault(); buttons[next].focus();
			}));
		}
	}

	private handlePointer(event: PointerEvent): void {
		const bounds = this.areaDomNode.getBoundingClientRect();
		const { h: hue, a } = this.selectedColor.hsva;
		this.change(new Color(new HSVA(hue, (event.clientX - bounds.left) / bounds.width, 1 - (event.clientY - bounds.top) / bounds.height, a)));
	}

	private change(color: Color): void {
		this.selectedColor = color;
		this.render();
		this.changeEmitter.fire(color);
	}

	private handleValueInput(input: HTMLInputElement): void {
		let color: Color | null = null;
		const alpha = this.selectedColor.rgba.a;
		if (input === this.alphaNumberInput) {
			if (input.value !== '' && input.checkValidity()) {
				const { h: hue, s, v } = this.selectedColor.hsva;
				color = new Color(new HSVA(hue, s, v, input.valueAsNumber / 100));
			}
		} else if (input === this.valueInput) {
			const value = input.value.trim();
			if (this.format === 'hex' && /^#?(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/iu.test(value)) {
				const hex = value.replace(/^#/u, '');
				color = Color.Format.CSS.parseHex(`#${hex}`);
				if (color && (hex.length === 3 || hex.length === 6)) {
					const { r, g, b } = color.rgba;
					color = new Color(new RGBA(r, g, b, alpha));
				}
			} else if (this.format === 'css') {
				color = this.parseCss(value);
			}
		} else if (this.channelInputs.every(channel => channel.value !== '' && channel.checkValidity())) {
			const [first, second, third] = this.channelInputs.map(channel => channel.valueAsNumber);
			if (this.format === 'rgb') { color = new Color(new RGBA(first, second, third, alpha)); }
			if (this.format === 'hsl') {
				const hsl = new Color(new HSLA(first, second / 100, third / 100, alpha));
				color = new Color(new HSVA(first, hsl.hsva.s, hsl.hsva.v, alpha));
			}
			if (this.format === 'hsb') { color = new Color(new HSVA(first, second / 100, third / 100, alpha)); }
		}
		if (!color) {
			input.setAttribute('aria-invalid', 'true');
			this.messageDomNode.textContent = localize('colorPicker.invalid', 'Enter a valid color or a number within the displayed range.');
			this.messageDomNode.hidden = false;
			return;
		}
		this.change(color);
		this.commitEmitter.fire(color);
	}

	private parseCss(value: string): Color | null {
		// Canvas resolves absolute CSS colors to sRGB; contextual values have no portable color meaning.
		if (!value || /\b(?:var|env|currentcolor|inherit|initial|unset|revert|light-dark)\b/iu.test(value)) { return null; }
		const canvas = h(this.domNode.ownerDocument, 'canvas', { properties: { width: 1, height: 1 } });
		const context = canvas.getContext('2d', { willReadFrequently: true })!;
		context.fillStyle = '#010203';
		context.fillStyle = value;
		const first = context.fillStyle;
		context.fillStyle = '#040506';
		context.fillStyle = value;
		if (context.fillStyle !== first) { return null; }
		// Reading translucent pixels quantizes their premultiplied RGB. Keep resolved sRGB channels exact.
		if (first.startsWith('#') || first.startsWith('rgb(') || first.startsWith('rgba(')) { return Color.Format.CSS.parse(first); }
		context.fillRect(0, 0, 1, 1);
		const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
		return new Color(new RGBA(r, g, b, a / 255));
	}

	private render(): void {
		const color = this.selectedColor;
		const { h: hue, s, v, a } = color.hsva;
		this.domNode.style.setProperty('--ash-color-picker-hue', Color.Format.CSS.formatHex(new Color(new HSVA(hue, 1, 1, 1))));
		this.domNode.style.setProperty('--ash-color-picker-opaque', Color.Format.CSS.formatHex(color));
		this.domNode.style.setProperty('--ash-color-picker-saturation', `${s * 100}%`);
		this.domNode.style.setProperty('--ash-color-picker-brightness', `${(1 - v) * 100}%`);
		this.areaDomNode.setAttribute('aria-valuenow', String(round(s * 100)));
		this.areaDomNode.setAttribute('aria-valuetext', localize('colorPicker.areaValue', 'Saturation {0}%, brightness {1}%', round(s * 100), round(v * 100)));
		this.hueInput.value = String(hue);
		this.alphaInput.value = this.alphaNumberInput.value = String(round(a * 100));
		const channels = this.format === 'rgb' || this.format === 'hsl' || this.format === 'hsb';
		this.valuesDomNode.classList.toggle('channels', channels);
		this.channelsDomNode.hidden = !channels;
		this.valueInput.hidden = channels;
		this.valueInput.value = this.format === 'css' ? `rgb(${color.rgba.r} ${color.rgba.g} ${color.rgba.b} / ${color.rgba.a})` : Color.Format.CSS.formatHex(color).slice(1).toUpperCase();
		let labels = ['H', 'S', 'B'];
		let values = [hue, s * 100, v * 100];
		let maximums = [360, 100, 100];
		if (this.format === 'rgb') {
			labels = ['R', 'G', 'B'];
			values = [color.rgba.r, color.rgba.g, color.rgba.b];
			maximums = [255, 255, 255];
		} else if (this.format === 'hsl') {
			labels = ['H', 'S', 'L'];
			values = [hue, color.hsla.s * 100, color.hsla.l * 100];
		}
		for (let index = 0; index < 3; index++) {
			const input = this.channelInputs[index];
			input.max = String(maximums[index]);
			input.step = this.format === 'rgb' || index === 0 ? '1' : '0.1';
			input.value = String(round(values[index]));
			input.setAttribute('aria-label', `${this.format.toUpperCase()} ${labels[index]}`);
			this.channelLabels[index].textContent = labels[index];
		}
		for (const input of [this.valueInput, this.alphaNumberInput, ...this.channelInputs]) { input.removeAttribute('aria-invalid'); }
		this.messageDomNode.hidden = true;
	}

	protected override disposeCore(): void {
		focusedPickers.delete(this.domNode);
		this.domNode.remove();
		super.disposeCore();
	}
}

function round(value: number): number { return Math.round(value * 10) / 10; }
