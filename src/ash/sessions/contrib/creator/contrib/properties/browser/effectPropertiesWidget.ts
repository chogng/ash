import { designEffectTypeLabel } from '../../../browser/designEffectLabels.js';
import { addDisposableListener, h } from '../../../../../../base/browser/dom.js';
import { Button } from '../../../../../../base/browser/ui/button/button.js';
import { ColorPicker } from '../../../../../../base/browser/ui/colorPicker/colorPicker.js';
import { ContextViewFocusRestore } from '../../../../../../base/browser/ui/contextview/contextview.js';
import { Color } from '../../../../../../base/common/color.js';
import { Disposable } from '../../../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../../../base/common/uuid.js';
import { localize } from '../../../../../../nls.js';
import type { IContextViewService } from '../../../../../../platform/contextview/browser/contextView.js';
import type { IContextKeyService } from '../../../../../../platform/contextkey/browser/contextKeyService.js';
import type { DesignDocumentController } from '../../../browser/designDocumentController.js';
import type { DocumentCommands } from '../../../common/commands/documentCommands.js';
import {
	canAddDesignEffect,
	createDesignEffect,
	designEffects,
	supportsDesignShadowSpread,
	type DesignEffect
} from '../../../common/model/designEffects.js';
import { designBlendModes, type DesignBlendMode } from '../../../common/model/designPaint.js';
import { flattenDesignShapes } from '../../../common/model/document.js';
import type { DesignSelection } from '../../../common/selection.js';
import { designBlendLabel } from '../../../browser/designPaintLabels.js';
const types: readonly DesignEffect['type'][] = ['drop-shadow', 'inner-shadow', 'layer-blur', 'background-blur'];

export class EffectPropertiesWidget extends Disposable {
	public readonly domNode: HTMLElement;
	private readonly updates: (() => void)[] = [];
	private pickerTarget: { shape: string; effect: string; } | undefined;
	private readonly picker: ColorPicker;
	constructor(
		private readonly controller: DesignDocumentController,
		private readonly commands: DocumentCommands,
		private readonly selection: DesignSelection,
		document: Document,
		private readonly refresh: () => void,
		private readonly focusCanvas: () => void,
		private readonly contextViews: IContextViewService,
		contextKeys: IContextKeyService,
	) {
		super();
		this.domNode = h(document, 'div', { className: 'ash-design-property-fields ash-design-property-wide' });
		const effectList = this.select(localize('sessions.design.effectLayer', 'Effect'), [], () => this.effect?.id ?? '', value => {
			this.selection.effectId = value;
			this.selection.editingBlur = false;
		});
		this.updates.push(() => {
			effectList.replaceChildren(...this.effects.map((effect, index) => h(
				document,
				'option',
				{ properties: { value: effect.id } },
				localize(
					'sessions.design.effectListEntry',
					'{0}: {1}',
					index + 1,
					designEffectTypeLabel(effect.type)
				)
			)));
			effectList.value = this.effect?.id ?? '';
		});
		this.action(localize('sessions.design.effectAdd', 'Add effect'), () => {
			const type = types.find(type => canAddDesignEffect(this.effects, type))!;
			const effect = createDesignEffect(type);
			this.selection.effectId = effect.id;
			this.setEffects([effect, ...this.effects]);
		}, () => types.some(type => canAddDesignEffect(this.effects, type)));
		this.action(localize('sessions.design.effectDuplicate', 'Duplicate effect'), () => {
			const effect = this.effect!, copy = { ...effect, id: generateUuid() };
			const effects = [...this.effects];
			effects.splice(effects.indexOf(effect), 0, copy);
			this.selection.effectId = copy.id;
			this.setEffects(effects);
		}, () => !!this.effect && canAddDesignEffect(this.effects, this.effect.type));
		this.action(localize('sessions.design.effectRemove', 'Remove effect'), () => {
			this.selection.editingBlur = false;
			this.setEffects(this.effects.filter(effect => effect.id !== this.effect?.id));
			this.selection.effectId = undefined;
		}, () => !!this.effect);
		for (const [direction, label] of [[-1, localize('sessions.design.effectUp', 'Move effect up')], [1, localize('sessions.design.effectDown', 'Move effect down')]] as const) {
			this.action(label, () => {
				const effects = [...this.effects], index = effects.indexOf(this.effect!);
				[effects[index], effects[index + direction]] = [effects[index + direction], effects[index]];
				this.setEffects(effects);
			}, () => !!this.effect && this.effects.indexOf(this.effect) + direction >= 0 && this.effects.indexOf(this.effect) + direction < this.effects.length);
		}
		const type = this.select(localize('sessions.design.effectType', 'Effect type'), types.map(type => [type, designEffectTypeLabel(type)]), () => this.effect?.type ?? 'drop-shadow', value => {
			const effect = this.effect!, next = value as DesignEffect['type'];
			if (next === effect.type || !canAddDesignEffect(this.effects, next)) {
				return;
			}
			const replacement = createDesignEffect(next);
			const shadow = this.shadow;
			this.edit({
				...replacement,
				id: effect.id,
				...(effect.visible === undefined ? {} : { visible: effect.visible }),
				blur: effect.blur,
				...(this.blur?.progressive && (next === 'layer-blur' || next === 'background-blur') ? { progressive: this.blur.progressive } : {}),
				...(shadow && (next === 'drop-shadow' || next === 'inner-shadow') ? {
					x: shadow.x,
					y: shadow.y,
					color: shadow.color,
					spread: shadow.spread ?? 0,
					...(shadow.blendMode ? { blendMode: shadow.blendMode } : {})
				} : {}),
			});
		});
		this.updates.push(() => {
			for (const option of type.options) {
				option.disabled = option.value !== this.effect?.type && !canAddDesignEffect(this.effects, option.value as DesignEffect['type']);
			}
		});
		this.checkbox(
			localize('sessions.design.effectVisible', 'Effect visible'),
			() => this.effect?.visible !== false,
			value => this.effect && this.edit({
				...this.effect,
				visible: value
			})
		);
		this.number(
			localize('sessions.design.effectBlur', 'Effect blur'),
			() => this.effect?.blur,
			value => this.effect && this.edit({
				...this.effect,
				blur: value
			}),
			() => !!this.effect && !this.blur?.progressive,
			0
		);
		this.select(
			localize('sessions.design.blurMode', 'Blur mode'),
			[['uniform', localize('sessions.design.blurUniform', 'Uniform')], ['progressive', localize('sessions.design.blurProgressive', 'Progressive')]],
			() => this.blur?.progressive ? 'progressive' : 'uniform',
			value => {
				if (!this.blur) { return; }
				const { progressive, ...effect } = this.blur;
				this.edit(value === 'progressive' ? {
					...effect,
					progressive: progressive ?? { startBlur: 0, start: { x: .5, y: 0 }, end: { x: .5, y: 1 } }
				} : effect);
			},
			() => !!this.blur
		);
		this.number(localize('sessions.design.blurStart', 'Start blur'), () => this.blur?.progressive?.startBlur, value => {
			if (this.blur?.progressive) { this.edit({ ...this.blur, progressive: { ...this.blur.progressive, startBlur: value } }); }
		}, () => !!this.blur?.progressive, 0);
		this.number(localize('sessions.design.blurEnd', 'End blur'), () => this.blur?.blur, value => {
			if (this.blur) { this.edit({ ...this.blur, blur: value }); }
		}, () => !!this.blur?.progressive, 0);
		const positions = [
			['start', 'x', localize('sessions.design.blurStartX', 'Blur start X (%)')],
			['start', 'y', localize('sessions.design.blurStartY', 'Blur start Y (%)')],
			['end', 'x', localize('sessions.design.blurEndX', 'Blur end X (%)')],
			['end', 'y', localize('sessions.design.blurEndY', 'Blur end Y (%)')]
		] as const;
		for (const [point, axis, label] of positions) {
			this.number(label, () => (this.blur?.progressive?.[point][axis] ?? 0) * 100, value => {
				const blur = this.blur;
				if (!blur?.progressive) { return; }
				this.edit({
					...blur, progressive: {
						...blur.progressive,
						[point]: { ...blur.progressive[point], [axis]: value / 100 }
					}
				});
			}, () => !!this.blur?.progressive);
		}
		const editBlur = this.action(localize('sessions.design.blurEdit', 'Edit blur on canvas'), () => {
			this.selection.effectId = this.blur!.id;
			this.selection.editingBlur = !this.selection.editingBlur;
			this.selection.editingGradient = false;
			this.selection.editingVector = false;
			this.selection.editingWidth = false;
			this.focusCanvas();
		}, () => !!this.blur?.progressive && this.blur.visible !== false, () => !!this.blur?.progressive);
		this.updates.push(() => editBlur.domNode.setAttribute('aria-pressed', String(this.selection.editingBlur)));
		this.number(localize('sessions.design.shadowX', 'Shadow X'), () => this.shadow?.x, value => this.shadow && this.edit({
			...this.shadow,
			x: value
		}), () => !!this.shadow);
		this.number(localize('sessions.design.shadowY', 'Shadow Y'), () => this.shadow?.y, value => this.shadow && this.edit({
			...this.shadow,
			y: value
		}), () => !!this.shadow);
		this.number(
			localize('sessions.design.effectSpread', 'Shadow spread'),
			() => this.shadow?.spread ?? 0,
			value => this.shadow && this.edit({
				...this.shadow,
				spread: value
			}),
			() => !!this.shadow && !!this.shape && supportsDesignShadowSpread(this.shape)
		);
		const spreadHint = h(
			document,
			'p',
			{ className: 'ash-design-property-wide' },
			localize('sessions.design.effectSpreadHint', 'Spread is available on rectangles, ellipses, and clipped frames with a visible fill.')
		);
		this.domNode.append(spreadHint);
		this.updates.push(() => {
			spreadHint.hidden = !this.shadow || !this.shape || supportsDesignShadowSpread(this.shape);
		});
		this.checkbox(
			localize('sessions.design.effectShowBehind', 'Show shadow behind transparent areas'),
			() => this.shadow?.showBehind ?? false,
			value => this.shadow?.type === 'drop-shadow' && this.edit({
				...this.shadow,
				showBehind: value
			}),
			() => this.shadow?.type === 'drop-shadow'
		);
		this.select(
			localize('sessions.design.effectBlend', 'Shadow blend mode'),
			designBlendModes.map(mode => [mode, designBlendLabel(mode)]),
			() => this.shadow?.blendMode ?? 'normal',
			value => this.shadow && this.edit({
				...this.shadow,
				blendMode: value as DesignBlendMode
			}),
			() => !!this.shadow
		);
		const color = h(
			document,
			'input',
			{
				properties: {
					type: 'text',
					pattern: '#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?',
					required: true
				},
				attributes: {
					'aria-label': localize('sessions.design.shadowColor', 'Shadow color')
				}
			}
		);
		const colorRow = h(document, 'label', { className: 'ash-design-property-wide' }, localize('sessions.design.shadowColor', 'Shadow color'), color);
		this.domNode.append(colorRow);
		this._register(addDisposableListener(color, 'change', () => {
			if (color.checkValidity() && this.editable && this.shadow) {
				this.edit({
					...this.shadow,
					color: color.value
				});
			} else {
				color.reportValidity();
			}
		}));
		this.updates.push(() => {
			colorRow.hidden = !this.shadow;
			color.disabled = !this.editable;
			if (document.activeElement !== color) {
				color.value = this.shadow?.color ?? '';
			}
		});
		this.picker = this._register(new ColorPicker(document));
		this._register(contextKeys.createScoped(this.picker.domNode)).createKey('sessionsDesignColorPickerFocused', true);
		const colorButton = this.action(localize('sessions.design.effectChooseColor', 'Choose shadow color'), () => {
			this.pickerTarget = { shape: this.shape!.id, effect: this.effect!.id };
			this.picker.setColor(Color.Format.CSS.parseHex(this.shadow!.color)!);
			colorButton.domNode.setAttribute('aria-expanded', 'true');
			this.contextViews.show({
				anchor: colorButton.domNode,
				content: this.picker.domNode,
				presentation: 'dialog',
				focusRestore: ContextViewFocusRestore.Previous,
				onHide: () => {
					this.pickerTarget = undefined;
					colorButton.domNode.setAttribute(
						'aria-expanded',
						'false'
					);
				}
			});
			this.picker.focus();
		}, () => !!this.shadow, () => !!this.shadow);
		colorButton.domNode.classList.add('ash-design-property-wide');
		colorButton.domNode.setAttribute('aria-haspopup', 'dialog');
		colorButton.domNode.setAttribute('aria-expanded', 'false');
		this._register(this.picker.onDidCommitColor(value => {
			if (this.editable && this.shadow && this.pickerTarget?.shape === this.shape?.id && this.pickerTarget?.effect === this.effect?.id) {
				this.edit({
					...this.shadow,
					color: Color.Format.CSS.formatHexA(
						value,
						true
					)
				});
			}
		}));
		this._register(this.picker.onDidRequestClose(() => this.contextViews.hide()));
	}

	private get shape() {
		return this.selection.ids.size === 1 ? flattenDesignShapes(this.controller.model.value.shapes).find(shape => this.selection.ids.has(shape.id)) : undefined;
	}

	private get editable(): boolean {
		return !!this.shape && !this.controller.isBusy && !this.commands.components.isInstanceChild(this.shape.id);
	}

	private get effects(): readonly DesignEffect[] {
		return this.shape ? designEffects(this.shape) : [];
	}

	private get effect() {
		return this.effects.find(effect => effect.id === this.selection.effectId) ?? this.effects[0];
	}

	private get blur() {
		const effect = this.effect;
		return effect?.type === 'layer-blur' || effect?.type === 'background-blur' ? effect : undefined;
	}

	private get shadow() {
		const effect = this.effect;
		return effect?.type === 'drop-shadow' || effect?.type === 'inner-shadow' ? effect : undefined;
	}

	private setEffects(effects: readonly DesignEffect[]): void {
		if (this.shape && this.editable) {
			this.commands.updateShape({
				...this.shape,
				effects
			});
		}
	}

	private edit(effect: DesignEffect): void {
		this.setEffects(this.effects.map(value => value.id === effect.id ? effect : value));
	}

	private action(
		label: string,
		run: () => void,
		enabled: () => boolean,
		visible = () => true): Button {
		const button = this._register(new Button(this.domNode, {
			label,
			ariaLabel: label,
			onClick: () => {
				if (this.editable && enabled()) {
					run();
					this.refresh();
				}
			}
		}));
		this.updates.push(() => {
			button.enabled = this.editable && enabled();
			button.domNode.hidden = !visible();
		});
		return button;
	}

	private select(
		label: string,
		choices: readonly (readonly [string, string])[],
		value: () => string,
		change: (value: string) => void,
		visible = () => true): HTMLSelectElement {
		const document = this.domNode.ownerDocument, input = h(document, 'select', { attributes: { 'aria-label': label } });
		input.append(...choices.map(([value, text]) => h(document, 'option', { properties: { value } }, text)));
		const row = h(document, 'label', { className: 'ash-design-property-wide' }, label, input);
		this.domNode.append(row);
		this._register(addDisposableListener(input, 'change', () => {
			if (this.editable && this.effect) {
				change(input.value);
				this.refresh();
			}
		}));
		this.updates.push(() => {
			row.hidden = !visible();
			input.disabled = !this.editable || !this.effect;
			input.value = value();
		});
		return input;
	}

	private number(
		label: string,
		value: () => number | undefined,
		change: (value: number) => void,
		visible: () => boolean,
		min?: number): void {
		const document = this.domNode.ownerDocument;
		const input = h(document, 'input', {
			properties: {
				type: 'number',
				step: 'any',
				...(min === undefined ? {} : { min: String(min) })
			},
			attributes: { 'aria-label': label }
		});
		const row = h(document, 'label', { className: 'ash-design-property-wide' }, label, input);
		this.domNode.append(row);
		const commit = () => {
			if (this.editable && input.checkValidity() && Number.isFinite(input.valueAsNumber)) {
				change(input.valueAsNumber);
			} else {
				input.reportValidity();
			}
		};
		this._register(addDisposableListener(input, 'change', commit));
		this._register(addDisposableListener(input, 'keydown', event => {
			if (event.key === 'Enter') {
				commit();
				event.preventDefault();
			}
		}));
		this.updates.push(() => {
			row.hidden = !visible();
			input.disabled = !this.editable;
			if (document.activeElement !== input) {
				input.value = String(value() ?? 0);
			}
		});
	}

	private checkbox(
		label: string,
		value: () => boolean,
		change: (value: boolean) => void,
		visible = () => true): void {
		const document = this.domNode.ownerDocument, input = h(document, 'input', {
			properties: { type: 'checkbox' },
			attributes: { 'aria-label': label }
		});
		const row = h(document, 'label', { className: 'ash-design-property-wide' }, input, label);
		this.domNode.append(row);
		this._register(addDisposableListener(input, 'change', () => {
			if (this.editable && this.effect) {
				change(input.checked);
			}
		}));
		this.updates.push(() => {
			row.hidden = !visible();
			input.disabled = !this.editable || !this.effect;
			input.checked = value();
		});
	}

	public update(): void {
		if (!this.blur?.progressive || !this.editable || this.blur.visible === false || this.blur.id !== this.selection.effectId) {
			this.selection.editingBlur = false;
		}
		if (this.pickerTarget && (this.pickerTarget.shape !== this.shape?.id || this.pickerTarget.effect !== this.effect?.id || !this.editable || !this.shadow)) {
			this.contextViews.hide();
		}
		for (const update of this.updates) {
			update();
		}
	}

	public override dispose(): void {
		if (this.pickerTarget) {
			this.contextViews.hide();
		}
		super.dispose();
	}
}
