import { defaultButtonStyles } from '../../../../../../platform/theme/browser/defaultStyles.js';
import { getFonts } from '../../../../../../base/browser/fonts.js';
import { Button } from '../../../../../../base/browser/ui/button/button.js';
import { generateUuid } from '../../../../../../base/common/uuid.js';
import { addDisposableListener, h } from '../../../../../../base/browser/dom.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../nls.js';
import type { DocumentCommands } from '../../../common/commands/documentCommands.js';
import type { DesignDocumentController } from '../../../browser/designDocumentController.js';
import type { IDesignTextContribution } from '../../../browser/designEditorBrowser.js';
import { getDesignResourceCatalog } from '../../../common/model/designResources.js';
import {
	convertDesignTextUnits,
	designTextSegments,
	designTextStyleAt,
	parseDesignTextStyle,
	type DesignTextProperties,
	type DesignTextShape,
	type DesignTextStyle,
} from '../../../common/model/designText.js';
import './textPropertiesWidget.css';

type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
/** Keeps the canvas character selection while controls own keyboard focus. */
export class TextPropertiesWidget extends Disposable {
	public readonly domNode: HTMLElement;
	private readonly controls = new Map<keyof DesignTextProperties | 'text', Control>();
	private readonly selectionLabel: HTMLElement;
	private readonly styleSelect: HTMLSelectElement;
	private readonly fontList: HTMLDataListElement;
	private readonly fontFamilies = new Set(['sans-serif', 'serif', 'monospace']);
	private shape: DesignTextShape | undefined;
	constructor(
		document: Document,
		private readonly controller: DesignDocumentController,
		private readonly commands: DocumentCommands,
		private readonly editor: IDesignTextContribution,
	) {
		super();
		this.domNode = h(document, 'div', { className: 'ash-design-text-properties ash-design-property-wide' });
		this.selectionLabel = h(document, 'div', {
			className: 'ash-design-text-selection ash-design-property-wide',
			attributes: { role: 'status' },
		});
		this.domNode.append(this.selectionLabel);
		const text = h(document, 'textarea', { attributes: { rows: '2' } });
		this.field(this.domNode, 'text', localize('sessions.design.textContent', 'Text content'), text, true);
		this._register(
			addDisposableListener(text, 'change', () => {
				if (this.shape) {
					this.editor.finish();
					this.commands.updateShape({ ...this.shape, text: text.value });
				}
			}),
		);
		const font = this.input('fontFamily', localize('sessions.design.fontFamily', 'Font family'), 'text', true);
		font.placeholder = 'sans-serif';
		this.fontList = h(document, 'datalist', { attributes: { id: `ash-design-fonts-${generateUuid()}` } });
		font.setAttribute('list', this.fontList.id);
		this.domNode.append(this.fontList);
		const fonts = h(document, 'div', { className: 'ash-design-property-wide' });
		const loadFonts = this._register(
			new Button(fonts, {
				...defaultButtonStyles,
				label: localize('sessions.design.loadFonts', 'Load installed fonts'),
			}),
		);
		const fontMessage = h(document, 'div', { attributes: { role: 'status' } });
		fonts.append(fontMessage);
		this.domNode.append(fonts);
		this._register(
			loadFonts.onDidClick(async () => {
				loadFonts.enabled = false;
				const families = await getFonts();
				if (this.isDisposed) {
					return;
				}
				for (const family of families) {
					if (family.trim() && family.length <= 256) {
						this.fontFamilies.add(family);
					}
				}
				this.updateFonts();
				loadFonts.enabled = true;
				fontMessage.textContent = families.length
					? localize('sessions.design.fontsLoaded', '{0} font families available.', new Set(families).size)
					: localize(
							'sessions.design.fontsUnavailable',
							'Font access is unavailable. You can enter a font family name.',
						);
			}),
		);
		this.updateFonts();
		this.number('fontSize', localize('sessions.design.fontSize', 'Font size'), 0.001);
		this.number('fontWeight', localize('sessions.design.fontWeight', 'Font weight'), 1, 1000);
		this.select('fontStyle', localize('sessions.design.fontStyle', 'Font style'), [
			['normal', localize('sessions.design.textRegular', 'Regular')],
			['italic', localize('sessions.design.textItalic', 'Italic')],
		]);
		this.input('fill', localize('sessions.design.textColor', 'Text color'), 'text');
		this.number('lineHeight', localize('sessions.design.lineHeight', 'Line height'), 0).placeholder = localize(
			'sessions.design.textAuto',
			'Auto',
		);
		this.select('lineHeightUnit', localize('sessions.design.lineHeightUnit', 'Line height unit'), [
			['px', 'px'],
			['percent', '%'],
		]);
		this.number('letterSpacing', localize('sessions.design.letterSpacing', 'Letter spacing'));
		this.select('letterSpacingUnit', localize('sessions.design.letterSpacingUnit', 'Letter spacing unit'), [
			['px', 'px'],
			['percent', '%'],
		]);
		this.select(
			'textAutoResize',
			localize('sessions.design.textResizing', 'Text resizing'),
			[
				['width', localize('sessions.design.textAutoWidth', 'Auto width')],
				['height', localize('sessions.design.textAutoHeight', 'Auto height')],
				['none', localize('sessions.design.textFixedSize', 'Fixed size')],
			],
			true,
			true,
		);
		this.select('textAlign', localize('sessions.design.textAlign', 'Text alignment'), [
			['left', localize('sessions.design.textLeft', 'Left')],
			['center', localize('sessions.design.textCenter', 'Center')],
			['right', localize('sessions.design.textRight', 'Right')],
			['justify', localize('sessions.design.textJustify', 'Justify')],
		]);
		this.select(
			'textVerticalAlign',
			localize('sessions.design.textVerticalAlign', 'Vertical alignment'),
			[
				['top', localize('sessions.design.textTop', 'Top')],
				['center', localize('sessions.design.textCenter', 'Center')],
				['bottom', localize('sessions.design.textBottom', 'Bottom')],
			],
			true,
		);
		this.styleSelect = h(document, 'select', {
			attributes: { 'aria-label': localize('sessions.design.rangeTextStyle', 'Text selection style') },
		});
		this.domNode.append(
			h(
				document,
				'label',
				{ className: 'ash-design-property-wide' },
				localize('sessions.design.rangeTextStyle', 'Text selection style'),
				this.styleSelect,
			),
		);
		this._register(
			addDisposableListener(this.styleSelect, 'change', () => {
				const style = getDesignResourceCatalog(this.controller.model.value.resources, true).styles.find(
					style => style.id === this.styleSelect.value,
				);
				if (!this.shape || !style) {
					return;
				}
				if (this.editor.editingId === this.shape.id) {
					this.editor.format(style.values, style.id);
				} else {
					this.commands.resources.applyStyle(new Set([this.shape.id]), 'text', style.id);
				}
			}),
		);
		const details = h(
			document,
			'details',
			{ className: 'ash-design-text-details ash-design-property-wide' },
			h(document, 'summary', {}, localize('sessions.design.typeDetails', 'Type details')),
		);
		const advanced = h(document, 'div', { className: 'ash-design-text-properties' });
		details.append(advanced);
		this.domNode.append(details);
		this.select(
			'textDecoration',
			localize('sessions.design.textDecoration', 'Decoration'),
			[
				['none', localize('sessions.design.textNone', 'None')],
				['underline', localize('sessions.design.textUnderline', 'Underline')],
				['line-through', localize('sessions.design.textStrikethrough', 'Strikethrough')],
				[
					'underline line-through',
					localize('sessions.design.textBothDecorations', 'Underline and strikethrough'),
				],
			],
			false,
			true,
			advanced,
		);
		this.select(
			'textCase',
			localize('sessions.design.textCase', 'Letter case'),
			[
				['original', localize('sessions.design.textOriginalCase', 'Original')],
				['upper', localize('sessions.design.textUppercase', 'Uppercase')],
				['lower', localize('sessions.design.textLowercase', 'Lowercase')],
				['title', localize('sessions.design.textTitleCase', 'Title case')],
				['small-caps', localize('sessions.design.textSmallCaps', 'Small caps')],
			],
			false,
			false,
			advanced,
		);
		this.select(
			'textDirection',
			localize('sessions.design.textDirection', 'Text direction'),
			[
				['auto', localize('sessions.design.textAuto', 'Auto')],
				['ltr', localize('sessions.design.textLtr', 'Left to right')],
				['rtl', localize('sessions.design.textRtl', 'Right to left')],
			],
			false,
			false,
			advanced,
		);
		this.select(
			'textWrap',
			localize('sessions.design.textWrap', 'Wrap style'),
			[
				['auto', localize('sessions.design.textAuto', 'Auto')],
				['balance', localize('sessions.design.textBalance', 'Balance')],
				['pretty', localize('sessions.design.textPretty', 'Pretty')],
			],
			false,
			false,
			advanced,
		);
		this.select(
			'textTrim',
			localize('sessions.design.textTrim', 'Vertical trim'),
			[
				['none', localize('sessions.design.textNone', 'None')],
				['cap-height', localize('sessions.design.textCapHeight', 'Cap height to baseline')],
			],
			false,
			true,
			advanced,
		);
		this.number(
			'paragraphSpacing',
			localize('sessions.design.paragraphSpacing', 'Paragraph spacing'),
			0,
			undefined,
			advanced,
		);
		this.number(
			'paragraphIndent',
			localize('sessions.design.paragraphIndent', 'Paragraph indent'),
			undefined,
			undefined,
			advanced,
		);
		this.select(
			'listType',
			localize('sessions.design.textList', 'List'),
			[
				['none', localize('sessions.design.textNone', 'None')],
				['bullet', localize('sessions.design.textBulleted', 'Bulleted')],
				['number', localize('sessions.design.textNumbered', 'Numbered')],
			],
			false,
			true,
			advanced,
		);
		for (const [key, label, hint] of [
			['fontFeatures', localize('sessions.design.fontFeatures', 'OpenType features'), 'liga=1, kern=1'],
			['fontVariations', localize('sessions.design.fontVariations', 'Variable font axes'), 'wght=600, wdth=100'],
		] as const) {
			const input = h(document, 'input', { properties: { type: 'text', placeholder: hint } });
			this.field(advanced, key, label, input, true);
			this._register(
				addDisposableListener(input, 'change', () => {
					try {
						const entries = input.value.trim()
							? input.value.split(',').map(entry => {
									const match = /^\s*([a-z\d]{4})\s*=\s*(-?\d+(?:\.\d+)?)\s*$/iu.exec(entry);
									if (!match) {
										throw new Error();
									}
									return [match[1], Number(match[2])] as const;
								})
							: [];
						this.style(parseDesignTextStyle({ [key]: Object.fromEntries(entries) }));
						input.removeAttribute('aria-invalid');
					} catch {
						input.setAttribute('aria-invalid', 'true');
					}
				}),
			);
		}
		const truncate = h(document, 'input', { properties: { type: 'checkbox' } });
		this.field(advanced, 'textTruncate', localize('sessions.design.textTruncate', 'Truncate text'), truncate);
		this._register(addDisposableListener(truncate, 'change', () => this.layer({ textTruncate: truncate.checked })));
		const lines = this.number(
			'maxLines',
			localize('sessions.design.textMaxLines', 'Max lines'),
			1,
			10000,
			advanced,
			true,
		);
		lines.step = '1';
		lines.placeholder = localize('sessions.design.textAuto', 'Auto');
		this._register(
			editor.onDidChangeSelection(() =>
				this.update(this.shape ? this.commands.text.get(this.shape.id) : undefined),
			),
		);
	}
	private updateFonts(): void {
		this.fontList.replaceChildren(
			...[...this.fontFamilies]
				.sort()
				.map(family => h(this.domNode.ownerDocument, 'option', { properties: { value: family } })),
		);
	}

	private field(
		parent: HTMLElement,
		key: keyof DesignTextProperties | 'text',
		label: string,
		control: Control,
		wide = false,
	): void {
		control.setAttribute('aria-label', label);
		this.controls.set(key, control);
		parent.append(
			h(parent.ownerDocument, 'label', { className: wide ? 'ash-design-property-wide' : '' }, label, control),
		);
	}
	private input(key: keyof DesignTextStyle, label: string, type: string, wide = false): HTMLInputElement {
		const input = h(this.domNode.ownerDocument, 'input', { properties: { type } });
		this.field(this.domNode, key, label, input, wide);
		this._register(
			addDisposableListener(input, 'change', () => {
				try {
					this.style(parseDesignTextStyle({ [key]: input.value }));
					input.removeAttribute('aria-invalid');
				} catch {
					input.setAttribute('aria-invalid', 'true');
				}
			}),
		);
		return input;
	}
	private number(
		key: keyof DesignTextProperties,
		label: string,
		min?: number,
		max?: number,
		parent = this.domNode,
		layer = false,
	): HTMLInputElement {
		const input = h(parent.ownerDocument, 'input', { properties: { type: 'number', step: 'any' } });
		if (min !== undefined) {
			input.min = String(min);
		}
		if (max !== undefined) {
			input.max = String(max);
		}
		this.field(parent, key, label, input);
		this._register(
			addDisposableListener(input, 'change', () => {
				const value = input.value === '' ? undefined : input.valueAsNumber;
				if (
					!input.checkValidity() ||
					(value !== undefined && !Number.isFinite(value)) ||
					(key === 'fontSize' && value === undefined)
				) {
					input.setAttribute('aria-invalid', 'true');
					return;
				}
				input.removeAttribute('aria-invalid');
				if (layer) {
					this.layer({ [key]: value });
				} else {
					this.style({ [key]: value });
				}
			}),
		);
		return input;
	}
	private select(
		key: keyof DesignTextProperties,
		label: string,
		options: readonly (readonly [string, string])[],
		layer = false,
		wide = false,
		parent = this.domNode,
	): void {
		const select = h(parent.ownerDocument, 'select');
		select.append(
			h(
				parent.ownerDocument,
				'option',
				{ properties: { value: '', disabled: true } },
				localize('sessions.design.textMixed', 'Mixed'),
			),
		);
		for (const [value, name] of options) {
			select.append(h(parent.ownerDocument, 'option', { properties: { value } }, name));
		}
		this.field(parent, key, label, select, wide);
		this._register(
			addDisposableListener(select, 'change', () =>
				layer ? this.layer({ [key]: select.value }) : this.style({ [key]: select.value }),
			),
		);
	}
	private style(style: DesignTextStyle): void {
		if (!this.shape || this.controller.isBusy) {
			return;
		}
		if (this.editor.editingId === this.shape.id) {
			this.editor.format(style);
		} else {
			this.commands.updateShape({
				...this.shape,
				...convertDesignTextUnits(this.shape, style),
				textRuns: this.shape.textRuns?.map(run => ({
					...run,
					style: { ...run.style, ...convertDesignTextUnits({ ...this.shape!, ...run.style }, style) },
					...(run.styleId
						? {
								overrides: [
									...new Set([
										...(run.overrides ?? []),
										...(Object.keys(style) as (keyof DesignTextStyle)[]),
									]),
								],
							}
						: {}),
				})),
			});
		}
	}
	private layer(properties: DesignTextProperties): void {
		if (!this.shape || this.controller.isBusy) {
			return;
		}
		let shape = { ...this.shape, ...properties };
		if (properties.maxLines !== undefined && shape.sizeLimits?.maxHeight !== undefined) {
			const { maxHeight: _maxHeight, ...sizeLimits } = shape.sizeLimits;
			shape = { ...shape, sizeLimits };
		}
		if (properties.textAutoResize) {
			shape = {
				...shape,
				sizing: {
					width: properties.textAutoResize === 'width' ? 'fixed' : (shape.sizing?.width ?? 'fixed'),
					height: 'fixed',
				},
				...(properties.textAutoResize === 'none' ? { maxLines: undefined } : {}),
			};
		}
		this.commands.updateShape(shape);
	}
	public update(shape: DesignTextShape | undefined): void {
		this.shape = shape;
		if (!shape) {
			return;
		}
		if (shape.fontFamily && !this.fontFamilies.has(shape.fontFamily)) {
			this.fontFamilies.add(shape.fontFamily);
			this.updateFonts();
		}
		const range = this.editor.editingId === shape.id ? this.editor.range : undefined;
		const segments =
			range && range.start !== range.end
				? designTextSegments(shape, range.start, range.end)
				: !range
					? designTextSegments(shape)
					: [];
		const styles = segments.length
			? segments.map(run => ({ ...shape, ...run.style }))
			: [{ ...designTextStyleAt(shape, Math.max(0, (range?.start ?? 0) - 1)), ...this.editor.typingStyle }];
		const defaults: DesignTextProperties = {
			fontFamily: 'sans-serif',
			fontWeight: 400,
			fontStyle: 'normal',
			letterSpacing: 0,
			lineHeightUnit: 'px',
			letterSpacingUnit: 'px',
			textAutoResize: 'none',
			textAlign: 'left',
			textVerticalAlign: 'top',
			textDecoration: 'none',
			textCase: 'original',
			textDirection: 'auto',
			textWrap: 'auto',
			textTrim: 'none',
			listType: 'none',
			paragraphSpacing: 0,
			paragraphIndent: 0,
		};
		this.selectionLabel.textContent = range
			? range.start === range.end
				? localize('sessions.design.textTypingStyle', 'Style for new text')
				: localize('sessions.design.textSelectionCount', '{0} characters selected', range.end - range.start)
			: localize('sessions.design.textAll', 'All text');
		for (const [key, control] of this.controls) {
			control.disabled =
				this.controller.isBusy ||
				(key === 'maxLines' &&
					(!shape.textTruncate || !shape.textAutoResize || shape.textAutoResize === 'none'));
			if (control.ownerDocument.activeElement === control) {
				continue;
			}
			const values = ['text', 'textAutoResize', 'textVerticalAlign', 'maxLines', 'textTruncate'].includes(key)
				? [Reflect.get(shape, key) ?? Reflect.get(defaults, key)]
				: styles.map(style => Reflect.get(style, key) ?? Reflect.get(defaults, key));
			const mixed = values.some(value => JSON.stringify(value) !== JSON.stringify(values[0]));
			const value = mixed ? undefined : values[0];
			if (control instanceof control.ownerDocument.defaultView!.HTMLInputElement && control.type === 'checkbox') {
				control.checked = !!value;
			} else {
				control.value =
					value === undefined
						? ''
						: typeof value === 'object'
							? Object.entries(value)
									.map(([tag, number]) => `${tag}=${number}`)
									.join(', ')
							: String(value);
			}
			if ('placeholder' in control && mixed) {
				control.placeholder = localize('sessions.design.textMixed', 'Mixed');
			}
			control.removeAttribute('aria-invalid');
		}
		const stylesAvailable = getDesignResourceCatalog(this.controller.model.value.resources, true).styles.filter(
			style => style.kind === 'text',
		);
		this.styleSelect.replaceChildren(
			h(
				this.domNode.ownerDocument,
				'option',
				{ properties: { value: '' } },
				localize('sessions.design.textChooseStyle', 'Choose text style'),
			),
			...stylesAvailable.map(style =>
				h(this.domNode.ownerDocument, 'option', { properties: { value: style.id } }, style.name),
			),
		);
		const styleIds = segments.map(run => run.styleId ?? shape.styleBindings?.text);
		this.styleSelect.value =
			range?.start === range?.end && this.editor.typingStyleId
				? this.editor.typingStyleId
				: styleIds.length && styleIds.every(id => id === styleIds[0])
					? (styleIds[0] ?? '')
					: '';
		this.styleSelect.disabled = this.controller.isBusy;
	}
}
