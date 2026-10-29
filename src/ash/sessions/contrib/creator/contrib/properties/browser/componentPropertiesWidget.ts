import { defaultButtonStyles } from '../../../../../../platform/theme/browser/defaultStyles.js';
import { addDisposableListener, h } from '../../../../../../base/browser/dom.js';
import { status } from '../../../../../../base/browser/ui/aria/aria.js';
import { Button } from '../../../../../../base/browser/ui/button/button.js';
import { Disposable, DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../nls.js';
import type { DesignDocumentController } from '../../../browser/designDocumentController.js';
import type { ComponentCommands } from '../../../common/commands/componentCommands.js';
import { flattenDesignShapes, type DesignOverride, type DesignShape } from '../../../common/model/document.js';
import { designPropertyLabel } from './resourcePropertiesWidget.js';
import {
	getDesignResourceCatalog,
	type DesignResources,
	type DesignBindableProperty,
} from '../../../common/model/designResources.js';
import type { DesignSelection } from '../../../common/selection.js';

/** Local component authoring shares the same properties surface and document command boundary. */
export class ComponentPropertiesWidget extends Disposable {
	private readonly controls = this._register(new DisposableStore());
	private readonly fields: HTMLElement;
	public readonly domNode: HTMLDetailsElement;
	private revision = '';
	constructor(
		private readonly documentController: DesignDocumentController,
		private readonly commands: ComponentCommands,
		private readonly selection: DesignSelection,
		ownerDocument: Document,
		private readonly refresh: () => void,
	) {
		super();
		this.fields = h(ownerDocument, 'div', { className: 'ash-design-property-fields ash-design-component-fields' });
		this.domNode = h(
			ownerDocument,
			'details',
			{ className: 'ash-design-property-section', properties: { open: true } },
			h(
				ownerDocument,
				'summary',
				{},
				localize('sessions.design.components', 'Components'),
				h(ownerDocument, 'span', {
					className: 'ash-design-property-disclosure',
					attributes: { 'aria-hidden': 'true' },
				}),
			),
			this.fields,
		);
	}
	public update(): void {
		const revision = `${this.documentController.model.version}:${[...this.selection.ids].join(',')}:${this.documentController.isBusy}`;
		if (revision === this.revision) {
			return;
		}
		this.revision = revision;
		const active = this.domNode.ownerDocument.activeElement;
		const focusKey =
			active && this.fields.contains(active) ? active.getAttribute('data-component-control') : undefined;
		const focusIndex = [...this.fields.querySelectorAll('[data-component-control]')].findIndex(
			control => control === active,
		);
		this.controls.clear();
		this.fields.replaceChildren();
		const selected =
			this.selection.ids.size === 1
				? flattenDesignShapes(this.documentController.model.value.shapes).find(shape =>
						this.selection.ids.has(shape.id),
					)
				: undefined;
		const frame = selected?.kind === 'frame' ? selected : undefined;
		const main = selected ? this.commands.getMain(selected.id) : undefined;
		const instance = selected ? this.commands.getInstance(selected.id) : undefined;
		const set = main ? this.commands.getSet(main.id) : frame?.component?.kind === 'set' ? frame : undefined;
		this.domNode.hidden = !selected && !this.selection.ids.size && !this.commands.mains.length;
		const select = (id: string | undefined): void => {
			if (id) {
				this.selection.set([id]);
				this.refresh();
			}
		};
		if (this.commands.canCreate(this.selection.ids)) {
			this.button('create', localize('sessions.design.createComponent', 'Create component'), () =>
				select(this.commands.create(this.selection.ids)),
			);
		}
		if (this.commands.canCombine(this.selection.ids)) {
			this.button('combine', localize('sessions.design.combineVariants', 'Combine as variants'), () =>
				select(this.commands.combine(this.selection.ids)),
			);
		}
		if (frame?.component) {
			this.button('insert', localize('sessions.design.createInstance', 'Create instance'), () =>
				select(this.commands.createInstance(frame.id)),
			);
			this.button('variant', localize('sessions.design.addVariant', 'Add variant'), () =>
				select(this.commands.addVariant(frame.id)),
			);
		}
		if (instance && selected) {
			this.fields.append(
				h(
					this.domNode.ownerDocument,
					'span',
					{ className: 'ash-design-property-wide' },
					main
						? localize(
								'sessions.design.instanceOf',
								'Instance of {0}',
								main.name || localize('sessions.design.component', 'Component'),
							)
						: localize('sessions.design.missingMain', 'Main component is missing'),
				),
			);
			if (main) {
				if (this.commands.isLocal(main.id)) {
					this.button('main', localize('sessions.design.goToMain', 'Go to main component'), () =>
						select(main.id),
					);
				}
				this.button('reset', localize('sessions.design.resetOverrides', 'Reset all overrides'), () =>
					this.commands.reset(selected.id),
				);
				if (frame?.instance && this.commands.canPush(frame.id)) {
					this.button('push', localize('sessions.design.pushOverrides', 'Push overrides to main'), () =>
						this.commands.push(frame.id),
					);
				}
			} else {
				this.button('restore', localize('sessions.design.restoreMain', 'Restore main component'), () =>
					select(this.commands.restore(instance.id)),
				);
			}
			if (frame?.instance) {
				if (!this.commands.isInstanceChild(frame.id)) {
					this.button('detach', localize('sessions.design.detachInstance', 'Detach instance'), () =>
						this.commands.detach(frame.id),
					);
				}
				const candidates = this.commands.mains.filter(source => this.commands.canSwap(frame.id, source.id));
				this.select(
					'swap',
					localize('sessions.design.swapInstance', 'Swap instance'),
					frame.instance.componentId,
					candidates.map(source => [source.id, componentLabel(source)]),
					value => this.commands.swap(frame.id, value),
				);
				if (set?.component?.kind === 'set' && main?.component?.kind === 'main') {
					for (const property of set.component.properties) {
						const values = [
							...new Set(
								set.children.flatMap(child =>
									child.kind === 'frame' && child.component?.kind === 'main'
										? [child.component.variant![property]]
										: [],
								),
							),
						];
						this.select(
							`variant:${property}`,
							localize('sessions.design.variantChoice', 'Variant: {0}', property),
							main.component.variant![property],
							values.map(value => [value, value]),
							value => this.commands.selectVariant(frame.id, property, value),
						);
					}
				}
			}
			const overrides = [...new Set(flattenDesignShapes([selected]).flatMap(shape => shape.overrides ?? []))];
			if (main && overrides.length) {
				this.select(
					'resetField',
					localize('sessions.design.resetProperty', 'Reset property'),
					'',
					[
						['', localize('sessions.design.chooseOverride', 'Choose an override')],
						...overrides.map(
							field =>
								[field, overrideLabel(field, this.documentController.model.value.resources)] as const,
						),
					],
					value => {
						if (value) {
							this.commands.reset(selected.id, value as DesignOverride);
						}
					},
				);
			}
		}
		if (!instance && set?.component?.kind === 'set') {
			const properties = set.component.properties;
			for (const property of properties) {
				this.input(
					`property:${property}`,
					localize('sessions.design.variantPropertyName', 'Property name: {0}', property),
					property,
					value =>
						this.commands.setProperties(
							set.id,
							properties.map(name => (name === property ? value : name)),
							[property, value],
						),
				);
				if (properties.length > 1) {
					this.button(
						`remove:${property}`,
						localize('sessions.design.removeVariantProperty', 'Remove {0}', property),
						() => {
							if (
								!this.commands.setProperties(
									set.id,
									properties.filter(name => name !== property),
								)
							) {
								status(
									localize(
										'sessions.design.ambiguousVariants',
										'Each variant must have a unique combination of property values.',
									),
								);
							}
						},
					);
				}
				if (frame?.component?.kind === 'main') {
					this.input(
						`value:${property}`,
						localize('sessions.design.variantValue', 'Value: {0}', property),
						frame.component.variant![property],
						value => this.commands.setVariantValue(frame.id, property, value),
					);
				}
			}
			this.button('addProperty', localize('sessions.design.addVariantProperty', 'Add variant property'), () => {
				let index = properties.length + 1;
				let name = localize('sessions.design.variantPropertyNumber', 'Property {0}', index);
				while (properties.includes(name)) {
					name = localize('sessions.design.variantPropertyNumber', 'Property {0}', ++index);
				}
				this.commands.setProperties(set.id, [...properties, name]);
			});
		}
		if (!instance && this.commands.mains.length) {
			this.select(
				'library',
				localize('sessions.design.insertComponent', 'Insert component'),
				'',
				[
					['', localize('sessions.design.chooseComponent', 'Choose a component')],
					...this.commands.mains.map(source => [source.id, componentLabel(source)] as const),
				],
				value => {
					if (value) {
						select(this.commands.createInstance(value));
					}
				},
			);
		}
		if (focusKey) {
			const controls = [...this.fields.querySelectorAll<HTMLElement>('[data-component-control]')];
			(
				controls.find(control => control.dataset.componentControl === focusKey) ??
				controls[Math.min(focusIndex, controls.length - 1)]
			)?.focus();
		}
	}
	private button(key: string, label: string, run: () => void): void {
		const button = this.controls.add(
			new Button(this.fields, {
				...defaultButtonStyles,
				label,
				onClick: () => {
					if (!this.documentController.isBusy) {
						run();
					}
				},
			}),
		);
		button.domNode.dataset.componentControl = key;
		button.enabled = !this.documentController.isBusy;
	}
	private select(
		key: string,
		label: string,
		value: string,
		options: readonly (readonly [string, string])[],
		change: (value: string) => void,
	): void {
		const doc = this.domNode.ownerDocument;
		const input = h(
			doc,
			'select',
			{
				attributes: { 'aria-label': label, 'data-component-control': key },
				properties: { disabled: this.documentController.isBusy },
			},
			...options.map(([value, label]) => h(doc, 'option', { properties: { value } }, label)),
		);
		input.value = value;
		this.fields.append(h(doc, 'label', { className: 'ash-design-property-wide' }, label, input));
		this.controls.add(
			addDisposableListener(input, 'change', () => {
				if (!this.documentController.isBusy) {
					change(input.value);
				}
			}),
		);
	}
	private input(key: string, label: string, value: string, change: (value: string) => boolean): void {
		const doc = this.domNode.ownerDocument;
		const input = h(doc, 'input', {
			attributes: { 'aria-label': label, 'data-component-control': key },
			properties: { type: 'text', value, maxLength: 256, disabled: this.documentController.isBusy },
		});
		this.fields.append(h(doc, 'label', { className: 'ash-design-property-wide' }, label, input));
		this.controls.add(addDisposableListener(input, 'input', () => input.setCustomValidity('')));
		this.controls.add(
			addDisposableListener(input, 'change', () => {
				if (this.documentController.isBusy) {
					return;
				}
				if (!change(input.value.trim())) {
					const message = localize(
						'sessions.design.invalidVariantProperty',
						'Use a non-empty, unique property name and a unique combination of variant values.',
					);
					input.setCustomValidity(message);
					input.reportValidity();
					status(message);
				}
			}),
		);
	}
}

function componentLabel(shape: Extract<DesignShape, { kind: 'frame' }>): string {
	const name = shape.name || localize('sessions.design.component', 'Component');
	return shape.component?.kind === 'main' && shape.component.variant
		? `${name} (${Object.entries(shape.component.variant)
				.map(([key, value]) => `${key}=${value}`)
				.join(', ')})`
		: name;
}

function overrideLabel(field: DesignOverride, resources: DesignResources | undefined): string {
	if (field.startsWith('bindings:')) {
		return localize(
			'sessions.design.bindingOverride',
			'Variable: {0}',
			designPropertyLabel(field.slice(9) as DesignBindableProperty),
		);
	}
	if (field.startsWith('styleBindings:')) {
		return localize(
			'sessions.design.styleOverride',
			'Style: {0}',
			{
				fill: localize('sessions.design.fillStyle', 'Paint style'),
				text: localize('sessions.design.textStyle', 'Text style'),
				effect: localize('sessions.design.effectStyle', 'Effect style'),
				grid: localize('sessions.design.gridStyle', 'Layout guide style'),
			}[field.slice(14) as 'fill'],
		);
	}
	if (field.startsWith('variableModes:')) {
		return localize(
			'sessions.design.modeOverride',
			'Mode: {0}',
			getDesignResourceCatalog(resources).collections.find(collection => collection.id === field.slice(14))
				?.name ?? localize('sessions.design.collection', 'Collection'),
		);
	}
	const labels: Partial<Record<DesignOverride, string>> = {
		visible: localize('sessions.design.visibility', 'Visibility'),
		opacity: localize('sessions.design.opacity', 'Opacity'),
		fontFamily: localize('sessions.design.fontFamily', 'Font family'),
		fontWeight: localize('sessions.design.fontWeight', 'Font weight'),
		lineHeight: localize('sessions.design.lineHeight', 'Line height'),
		letterSpacing: localize('sessions.design.letterSpacing', 'Letter spacing'),
		effects: localize('sessions.design.effectStyle', 'Effect style'),
		layoutGuide: localize('sessions.design.gridStyle', 'Layout guide style'),
		bindings: localize('sessions.design.variables', 'Variables'),
		styleBindings: localize('sessions.design.styles', 'Styles'),
		variableModes: localize('sessions.design.variableModes', 'Variable modes'),
		name: localize('sessions.design.layerName', 'Layer name'),
		width: localize('sessions.design.width', 'Width'),
		height: localize('sessions.design.height', 'Height'),
		fill: localize('sessions.design.fill', 'Fill'),
		text: localize('sessions.design.text', 'Text'),
		fontSize: localize('sessions.design.fontSize', 'Font size'),
		strokeWidth: localize('sessions.design.strokeWidth', 'Stroke width'),
		crop: localize('sessions.design.imageCrop', 'Image crop'),
		assetId: localize('sessions.design.image', 'Image'),
		assetVersionId: localize('sessions.design.imageVersion', 'Image version'),
		autoLayout: localize('sessions.design.autoLayout', 'Auto layout'),
		sizeLimits: localize('sessions.design.sizeLimits', 'Size limits'),
		motion: localize('sessions.design.animation', 'Animation'),
		interactions: localize('sessions.design.prototype.interactions', 'Prototype interactions'),
		instance: localize('sessions.design.instance', 'Instance'),
	};
	return labels[field]!;
}
