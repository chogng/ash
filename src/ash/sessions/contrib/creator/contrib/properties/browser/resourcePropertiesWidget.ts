import { defaultButtonStyles } from '../../../../../../platform/theme/browser/defaultStyles.js';
import { Color } from '../../../../../../base/common/color.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { createDesignColorPicker } from '../../../browser/widgets/designColorPicker.js';
import { describeDesignEffect } from '../../../browser/designEffectLabels.js';
import { addDisposableListener, h } from '../../../../../../base/browser/dom.js';
import { status } from '../../../../../../base/browser/ui/aria/aria.js';
import { Button } from '../../../../../../base/browser/ui/button/button.js';
import { Disposable, DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../../nls.js';
import { getDesignRenderBounds, renderDesignShape } from '../../../browser/svgRenderer.js';
import type { DesignDocumentController } from '../../../browser/designDocumentController.js';
import type { DocumentCommands } from '../../../common/commands/documentCommands.js';
import { flattenDesignShapes, type DesignDocument, type DesignShape } from '../../../common/model/document.js';
import {
	designPropertyTypes,
	getDesignResourceCatalog,
	supportsDesignProperty,
	getDesignProperty,
	type DesignLibrary,
	type DesignBindableProperty,
	type DesignStyleKind,
	type DesignVariableType,
} from '../../../common/model/designResources.js';
import type { DesignSelection } from '../../../common/selection.js';

/** Only editor choices live here; all definitions, links and accepted versions belong to the document. */
export class ResourcePropertiesWidget extends Disposable {
	public readonly domNode: HTMLDetailsElement;
	private readonly fields: HTMLElement;
	private readonly controls = this._register(new DisposableStore());
	private collectionId = '';
	private variableId = '';
	private variableType: DesignVariableType = 'color';
	private property: DesignBindableProperty = 'fill';
	private styleKind: DesignStyleKind = 'fill';
	private styleId = '';
	private revision = '';
	constructor(
		private readonly controller: DesignDocumentController,
		private readonly commands: DocumentCommands,
		private readonly selection: DesignSelection,
		ownerDocument: Document,
		@IInstantiationService private readonly instantiation: IInstantiationService,
	) {
		super();
		this.fields = h(ownerDocument, 'div', { className: 'ash-design-resource-fields' });
		this.domNode = h(
			ownerDocument,
			'details',
			{ className: 'ash-design-property-section ash-design-resources' },
			h(
				ownerDocument,
				'summary',
				{},
				localize('sessions.design.resources', 'Design resources'),
				h(ownerDocument, 'span', {
					className: 'ash-design-property-disclosure',
					attributes: { 'aria-hidden': 'true' },
				}),
			),
			this.fields,
		);
	}
	public update(force = false): void {
		const document = this.controller.model.value;
		const resources = this.commands.resources.value;
		const revision = `${this.controller.model.version}:${[...this.selection.ids]}:${this.controller.isBusy}:${resources.libraries.map(library => this.controller.getLibraryUpdate(library.id)?.version ?? '').join(',')}`;
		if (!force && revision === this.revision) {
			return;
		}
		this.revision = revision;
		const active = this.domNode.ownerDocument.activeElement;
		const key = active && this.fields.contains(active) ? active.getAttribute('data-resource-control') : undefined;
		const index = [...this.fields.querySelectorAll('[data-resource-control]')].findIndex(
			control => control === active,
		);
		const open = new Set(
			[...this.fields.querySelectorAll<HTMLDetailsElement>('details[open]')].map(
				detail => detail.dataset.resourceSection ?? '',
			),
		);
		this.controls.clear();
		this.fields.replaceChildren();
		const shape =
			this.selection.ids.size === 1
				? flattenDesignShapes(document.shapes).find(shape => this.selection.ids.has(shape.id))
				: undefined;
		const catalog = getDesignResourceCatalog(resources, true);
		const bindings = this.section(
			'bindings',
			localize('sessions.design.resourceBindings', 'Bindings and modes'),
			open,
		);
		if (shape) {
			const properties = (Object.keys(designPropertyTypes) as DesignBindableProperty[]).filter(property =>
				supportsDesignProperty(shape, property),
			);
			if (!properties.includes(this.property)) {
				this.property = 'fill';
			}
			this.select(
				bindings,
				'property',
				localize('sessions.design.bindProperty', 'Bind property'),
				this.property,
				properties.map(property => [property, designPropertyLabel(property)]),
				value => {
					this.property = value as DesignBindableProperty;
					this.update(true);
				},
			);
			const variables = catalog.variables.filter(
				variable => variable.type === designPropertyTypes[this.property],
			);
			const styleVariable = getDesignResourceCatalog(resources).styles.find(
				style => shape.styleBindings?.[style.kind] === style.id && style.bindings?.[this.property],
			)?.bindings?.[this.property];
			const currentId = shape.bindings?.[this.property] ?? (styleVariable ? '@style' : '');
			const choices: [string, string][] = [
				['', localize('sessions.design.literalValue', 'Literal value')],
				...variables.map(variable => [variable.id, variable.name] as [string, string]),
			];
			if (styleVariable) {
				choices.push([
					'@style',
					localize(
						'sessions.design.fromStyle',
						'From style: {0}',
						getDesignResourceCatalog(resources).variables.find(variable => variable.id === styleVariable)
							?.name ?? localize('sessions.design.variable', 'Variable'),
					),
				]);
			}
			if (currentId && currentId !== '@style' && !variables.some(variable => variable.id === currentId)) {
				choices.push([
					currentId,
					localize('sessions.design.unavailableResource', 'Unavailable resource (last value retained)'),
				]);
			}
			this.select(
				bindings,
				'binding',
				localize('sessions.design.variable', 'Variable'),
				currentId,
				choices,
				value =>
					this.commands.resources.bind(
						this.selection.ids,
						this.property,
						value === '@style' ? '' : value,
						value === '@style',
					),
			);
		}
		for (const collection of catalog.collections) {
			this.select(
				bindings,
				`mode:${collection.id}`,
				localize('sessions.design.collectionMode', '{0} mode', collection.name),
				(shape ? shape.variableModes : resources.modes)?.[collection.id] ?? '',
				[
					['', localize('sessions.design.inheritMode', 'Auto (inherit mode)')],
					...collection.modes.map(mode => [mode.id, mode.name] as const),
				],
				value => this.commands.resources.setMode(this.selection.ids, collection.id, value),
			);
		}
		if (!shape && !catalog.collections.length) {
			bindings.append(
				h(
					this.domNode.ownerDocument,
					'p',
					{},
					localize(
						'sessions.design.resourcesStart',
						'Create a variable collection, or add a library to reuse its variables, styles and components.',
					),
				),
			);
		}

		const variables = this.section('variables', localize('sessions.design.variables', 'Variables'), open);
		this.button(
			variables,
			'addCollection',
			localize('sessions.design.createCollection', 'Create collection'),
			() => {
				this.collectionId = this.commands.resources.addCollection(
					unique(
						localize('sessions.design.collection', 'Collection'),
						resources.collections.map(collection => collection.name),
					),
				);
				this.update(true);
			},
		);
		const collection =
			resources.collections.find(collection => collection.id === this.collectionId) ?? resources.collections[0];
		if (collection) {
			this.collectionId = collection.id;
			this.select(
				variables,
				'collection',
				localize('sessions.design.collection', 'Collection'),
				collection.id,
				resources.collections.map(collection => [collection.id, collection.name]),
				value => {
					this.collectionId = value;
					this.variableId = '';
					this.update(true);
				},
			);
			this.input(
				variables,
				'collectionName',
				localize('sessions.design.collectionName', 'Collection name'),
				collection.name,
				value => this.commands.resources.renameCollection(collection.id, this.name(value)),
			);
			this.button(
				variables,
				'deleteCollection',
				localize('sessions.design.deleteVariableCollection', 'Delete collection'),
				() => this.commands.resources.deleteCollection(collection.id),
			);
			this.select(
				variables,
				'defaultMode',
				localize('sessions.design.defaultMode', 'Default'),
				collection.defaultMode,
				collection.modes.map(mode => [mode.id, mode.name]),
				value => this.commands.resources.setDefaultMode(collection.id, value),
			);
			for (const mode of collection.modes) {
				this.input(
					variables,
					`modeName:${mode.id}`,
					localize('sessions.design.modeName', 'Mode name: {0}', mode.name),
					mode.name,
					value => {
						const name = this.name(value);
						if (collection.modes.some(other => other.id !== mode.id && other.name === name)) {
							this.invalid();
						}
						this.commands.resources.renameMode(collection.id, mode.id, name);
					},
				);
				if (collection.modes.length > 1) {
					this.button(
						variables,
						`deleteMode:${mode.id}`,
						localize('sessions.design.deleteMode', 'Delete mode: {0}', mode.name),
						() => this.commands.resources.deleteMode(collection.id, mode.id),
					);
				}
			}
			this.button(variables, 'addMode', localize('sessions.design.addMode', 'Add mode'), () =>
				this.commands.resources.addMode(
					collection.id,
					unique(
						localize('sessions.design.mode', 'Mode'),
						collection.modes.map(mode => mode.name),
					),
				),
			);
			this.select(
				variables,
				'type',
				localize('sessions.design.variableType', 'Variable type'),
				this.variableType,
				Object.entries(typeLabels()),
				value => {
					this.variableType = value as DesignVariableType;
				},
			);
			const local = resources.variables.filter(variable => variable.collectionId === collection.id);
			this.button(variables, 'addVariable', localize('sessions.design.createVariable', 'Create variable'), () => {
				this.variableId = this.commands.resources.addVariable(
					collection.id,
					unique(
						localize('sessions.design.variable', 'Variable'),
						local.map(variable => variable.name),
					),
					this.variableType,
				);
				this.update(true);
			});
			const variable = local.find(variable => variable.id === this.variableId) ?? local[0];
			if (variable) {
				this.variableId = variable.id;
				this.select(
					variables,
					'editVariable',
					localize('sessions.design.editVariable', 'Edit variable'),
					variable.id,
					local.map(variable => [variable.id, variable.name]),
					value => {
						this.variableId = value;
						this.update(true);
					},
				);
				this.input(
					variables,
					'variableName',
					localize('sessions.design.variableName', 'Variable name'),
					variable.name,
					value => this.commands.resources.renameVariable(variable.id, this.name(value)),
				);
				for (const mode of collection.modes) {
					const value = variable.values[mode.id];
					const alias = typeof value === 'object' ? value.alias : '';
					this.select(
						variables,
						`alias:${mode.id}`,
						localize('sessions.design.valueSource', '{0}: value source', mode.name),
						alias,
						[
							['', localize('sessions.design.literalValue', 'Literal value')],
							...catalog.variables
								.filter(other => other.type === variable.type && other.id !== variable.id)
								.map(other => [other.id, other.name] as const),
						],
						id =>
							this.commands.resources.setVariableValue(
								variable.id,
								mode.id,
								id
									? { alias: id }
									: variable.type === 'color'
										? '#808080'
										: variable.type === 'number'
											? 16
											: variable.type === 'boolean'
												? true
												: '',
							),
					);
					if (!alias) {
						const label = localize('sessions.design.modeValue', '{0}: value', mode.name);
						if (variable.type === 'boolean') {
							this.select(
								variables,
								`value:${mode.id}`,
								label,
								String(value),
								[
									['true', localize('sessions.design.true', 'True')],
									['false', localize('sessions.design.false', 'False')],
								],
								value =>
									this.commands.resources.setVariableValue(variable.id, mode.id, value === 'true'),
							);
						} else if (variable.type === 'color') {
							this.color(variables, `value:${mode.id}`, label, String(value), value =>
								this.commands.resources.setVariableValue(variable.id, mode.id, value),
							);
						} else {
							this.input(
								variables,
								`value:${mode.id}`,
								label,
								String(value),
								value => {
									this.commands.resources.setVariableValue(
										variable.id,
										mode.id,
										variable.type === 'number' ? this.numeric(value) : value,
									);
								},
								variable.type === 'number' ? 'number' : 'text',
							);
						}
					}
				}
				this.button(
					variables,
					'deleteVariable',
					localize('sessions.design.deleteVariable', 'Delete variable'),
					() => this.commands.resources.deleteVariable(variable.id),
				);
			}
		}

		const styles = this.section('styles', localize('sessions.design.styles', 'Styles'), open);
		this.select(
			styles,
			'styleKind',
			localize('sessions.design.styleType', 'Style type'),
			this.styleKind,
			Object.entries(styleLabels()),
			value => {
				this.styleKind = value as DesignStyleKind;
				this.styleId = '';
				this.update(true);
			},
		);
		const applicable =
			!!shape &&
			(this.styleKind !== 'text' || shape.kind === 'text') &&
			(this.styleKind !== 'grid' || shape.kind === 'frame');
		if (shape && applicable) {
			this.appearance(styles, shape);
			const available = catalog.styles.filter(style => style.kind === this.styleKind);
			const current = shape.styleBindings?.[this.styleKind] ?? '';
			const choices: [string, string][] = [
				['', localize('sessions.design.noStyle', 'No style')],
				...available.map(style => [style.id, style.name] as [string, string]),
			];
			if (current && !available.some(style => style.id === current)) {
				choices.push([
					current,
					localize('sessions.design.unavailableResource', 'Unavailable resource (last value retained)'),
				]);
			}
			this.select(
				styles,
				'applyStyle',
				localize('sessions.design.applyStyle', 'Apply style'),
				current,
				choices,
				value => {
					this.styleId = value;
					this.commands.resources.applyStyle(this.selection.ids, this.styleKind, value);
				},
			);
			this.button(
				styles,
				'createStyle',
				localize('sessions.design.createStyle', 'Create style from selection'),
				() => {
					this.styleId = this.commands.resources.createStyle(
						shape,
						this.styleKind,
						unique(
							styleLabels()[this.styleKind],
							resources.styles.map(style => style.name),
						),
					);
					this.update(true);
				},
			);
		}
		const localStyles = resources.styles.filter(style => style.kind === this.styleKind);
		const style = localStyles.find(style => style.id === this.styleId) ?? localStyles[0];
		if (style) {
			this.styleId = style.id;
			this.select(
				styles,
				'editStyle',
				localize('sessions.design.editStyle', 'Edit style'),
				style.id,
				localStyles.map(style => [style.id, style.name]),
				value => {
					this.styleId = value;
					this.update(true);
				},
			);
			this.input(styles, 'styleName', localize('sessions.design.styleName', 'Style name'), style.name, value =>
				this.commands.resources.renameStyle(style.id, this.name(value)),
			);
			if (shape && applicable) {
				this.button(
					styles,
					'updateStyle',
					localize('sessions.design.updateStyle', 'Update style from selection'),
					() => this.commands.resources.updateStyle(style.id, shape),
				);
			}
			this.button(styles, 'deleteStyle', localize('sessions.design.deleteStyle', 'Delete style'), () =>
				this.commands.resources.deleteStyle(style.id),
			);
		}

		const libraries = this.section('libraries', localize('sessions.design.libraries', 'Libraries'), open);
		this.button(libraries, 'publish', localize('sessions.design.publishLibrary', 'Publish library'), () =>
			this.controller.publishLibrary(),
		);
		this.button(libraries, 'addLibrary', localize('sessions.design.addLibrary', 'Add library'), () =>
			this.controller.addLibrary(),
		);
		for (const library of resources.libraries) {
			libraries.append(
				h(this.domNode.ownerDocument, 'p', { className: 'ash-design-resource-name' }, library.name),
			);
			this.select(
				libraries,
				`enabled:${library.id}`,
				localize('sessions.design.libraryAvailability', '{0}: availability', library.name),
				String(library.enabled),
				[
					['true', localize('sessions.design.libraryEnabled', 'Enabled')],
					['false', localize('sessions.design.libraryDisabled', 'Disabled (keep existing references)')],
				],
				value => this.commands.resources.setLibraryEnabled(library.id, value === 'true'),
			);
			this.button(
				libraries,
				`check:${library.id}`,
				localize('sessions.design.checkLibrary', 'Check updates: {0}', library.name),
				() => this.controller.checkLibraryUpdate(library.id),
			);
			const update = this.controller.getLibraryUpdate(library.id);
			if (update) {
				libraries.append(
					h(
						this.domNode.ownerDocument,
						'p',
						{ attributes: { role: 'status' } },
						localize(
							'sessions.design.libraryUpdateAvailable',
							'Review the published changes before updating {0}.',
							library.name,
						),
					),
				);
				const before = libraryEntries(library.document);
				const after = libraryEntries(update.document);
				for (const id of new Set([...before.keys(), ...after.keys()])) {
					const old = before.get(id);
					const next = after.get(id);
					if (JSON.stringify(old) === JSON.stringify(next)) {
						continue;
					}
					const change = h(
						this.domNode.ownerDocument,
						'details',
						{
							className: 'ash-design-resource-change',
							attributes: { 'data-resource-section': `change:${id}` },
							properties: { open: open.has(`change:${id}`) },
						},
						h(
							this.domNode.ownerDocument,
							'summary',
							{},
							localize(
								'sessions.design.libraryChange',
								'{0}: {1}',
								next?.name ?? old?.name ?? id,
								!old
									? localize('sessions.design.added', 'Added')
									: !next
										? localize('sessions.design.removed', 'Removed')
										: localize('sessions.design.changed', 'Changed'),
							),
						),
						h(
							this.domNode.ownerDocument,
							'pre',
							{},
							localize(
								'sessions.design.libraryBeforeAfter',
								'Before:\n{0}\n\nAfter:\n{1}',
								old?.description ?? localize('sessions.design.noResource', 'Not present'),
								next?.description ?? localize('sessions.design.noResource', 'Not present'),
							),
						),
					);
					if (old?.shape || next?.shape) {
						const previews = h(this.domNode.ownerDocument, 'div', {
							className: 'ash-design-library-previews',
						});
						if (old?.shape) {
							previews.append(
								this.preview(old.shape, library, localize('sessions.design.before', 'Before')),
							);
						}
						if (next?.shape) {
							previews.append(
								this.preview(next.shape, update, localize('sessions.design.after', 'After')),
							);
						}
						change.append(previews);
					}
					libraries.append(change);
				}
				this.button(
					libraries,
					`accept:${library.id}`,
					localize('sessions.design.acceptLibraryUpdate', 'Accept update: {0}', library.name),
					() => this.controller.acceptLibraryUpdate(library.id),
				);
			}
		}
		if (key) {
			const controls = [...this.fields.querySelectorAll<HTMLElement>('[data-resource-control]')];
			(
				controls.find(control => control.dataset.resourceControl === key) ??
				controls[Math.min(index, controls.length - 1)]
			)?.focus();
		}
	}
	private preview(shape: DesignShape, library: DesignLibrary, caption: string): HTMLElement {
		const doc = this.domNode.ownerDocument;
		const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
		const bounds = getDesignRenderBounds([shape]);
		svg.setAttribute('viewBox', `${bounds.x - 8} ${bounds.y - 8} ${bounds.width + 16} ${bounds.height + 16}`);
		svg.setAttribute('aria-hidden', 'true');
		svg.append(renderDesignShape(shape, undefined, this.controller.getLibraryImageSources(library)));
		for (const guide of svg.querySelectorAll('[data-layout-guide]')) {
			guide.remove();
		}
		return h(doc, 'figure', {}, h(doc, 'figcaption', {}, caption), svg);
	}

	private appearance(parent: HTMLElement, shape: DesignShape): void {
		const edit = (patch: Partial<DesignShape>): void =>
			this.commands.updateShape({ ...shape, ...patch } as DesignShape);
		this.select(
			parent,
			'visible',
			localize('sessions.design.visibility', 'Visibility'),
			String(shape.visible !== false),
			[
				['true', localize('sessions.design.visible', 'Visible')],
				['false', localize('sessions.design.hidden', 'Hidden')],
			],
			value => edit({ visible: value === 'true' }),
		);
		this.input(
			parent,
			'opacity',
			localize('sessions.design.layerOpacity', 'Layer opacity (0–1)'),
			String(shape.opacity ?? 1),
			value => edit({ opacity: this.numeric(value, 0, 1) }),
			'number',
		);
		if (this.styleKind === 'grid' && shape.kind === 'frame') {
			const guide = shape.layoutGuide ?? { size: 8, color: '#ff000040' };
			this.input(
				parent,
				'guideSize',
				localize('sessions.design.guideSize', 'Layout guide size'),
				String(guide.size),
				value => edit({ layoutGuide: { ...guide, size: this.numeric(value, 0.001) } }),
				'number',
			);
			this.color(
				parent,
				'guideColor',
				localize('sessions.design.guideColor', 'Layout guide color'),
				guide.color,
				value => edit({ layoutGuide: { ...guide, color: value } }),
			);
			this.button(
				parent,
				'toggleGuide',
				shape.layoutGuide
					? localize('sessions.design.removeGuide', 'Remove layout guide')
					: localize('sessions.design.addGuide', 'Add layout guide'),
				() => edit({ layoutGuide: shape.layoutGuide ? undefined : guide }),
			);
		}
	}
	private section(key: string, label: string, open: ReadonlySet<string>): HTMLElement {
		const fields = h(this.domNode.ownerDocument, 'div', { className: 'ash-design-resource-controls' });
		this.fields.append(
			h(
				this.domNode.ownerDocument,
				'details',
				{ attributes: { 'data-resource-section': key }, properties: { open: open.has(key) } },
				h(this.domNode.ownerDocument, 'summary', {}, label),
				fields,
			),
		);
		return fields;
	}
	private run(action: () => unknown): void {
		if (this.controller.isBusy) {
			return;
		}
		try {
			const result = action();
			if (result instanceof Promise) {
				void result.catch(error => status(String(error)));
			}
		} catch (error) {
			status(String(error));
			this.update(true);
		}
	}
	private button(parent: HTMLElement, key: string, label: string, action: () => unknown): void {
		const button = this.controls.add(
			new Button(parent, { ...defaultButtonStyles, label, onClick: () => this.run(action) }),
		);
		button.enabled = !this.controller.isBusy;
		button.domNode.dataset.resourceControl = key;
	}
	private select(
		parent: HTMLElement,
		key: string,
		label: string,
		value: string,
		choices: readonly (readonly [string, string])[],
		change: (value: string) => unknown,
	): void {
		const input = h(
			this.domNode.ownerDocument,
			'select',
			{
				attributes: { 'aria-label': label, 'data-resource-control': key },
				properties: { disabled: this.controller.isBusy },
			},
			...choices.map(([value, label]) =>
				h(this.domNode.ownerDocument, 'option', { properties: { value } }, label),
			),
		);
		input.value = value;
		parent.append(h(this.domNode.ownerDocument, 'label', {}, label, input));
		this.controls.add(addDisposableListener(input, 'change', () => this.run(() => change(input.value))));
	}
	private color(
		parent: HTMLElement,
		key: string,
		label: string,
		value: string,
		change: (value: string) => unknown,
	): void {
		const widget = this.controls.add(
			createDesignColorPicker(this.instantiation, this.domNode.ownerDocument, {
				color: label,
				value: label,
				opacity: localize('sessions.design.colorOpacity', '{0}: opacity (%)', label),
			}),
		);
		widget.setColor(Color.Format.CSS.parseHex(value)!);
		widget.enabled = !this.controller.isBusy;
		parent.append(
			h(this.domNode.ownerDocument, 'div', {}, h(this.domNode.ownerDocument, 'span', {}, label), widget.domNode),
		);
		for (const [index, element] of [...widget.domNode.querySelectorAll('button, input')].entries()) {
			element.setAttribute(
				'data-resource-control',
				index === 1 ? key : `${key}:${index === 0 ? 'swatch' : 'opacity'}`,
			);
		}
		this.controls.add(
			widget.onDidCommitColor(color => this.run(() => change(Color.Format.CSS.formatHexA(color, true)))),
		);
	}

	private input(
		parent: HTMLElement,
		key: string,
		label: string,
		value: string,
		change: (value: string) => unknown,
		type = 'text',
	): void {
		const input = h(this.domNode.ownerDocument, 'input', {
			attributes: { 'aria-label': label, 'data-resource-control': key },
			properties: { type, value, step: 'any', disabled: this.controller.isBusy },
		});
		parent.append(h(this.domNode.ownerDocument, 'label', {}, label, input));
		this.controls.add(addDisposableListener(input, 'input', () => input.setCustomValidity('')));
		this.controls.add(
			addDisposableListener(input, 'change', () => {
				if (this.controller.isBusy) {
					return;
				}
				try {
					change(input.value);
				} catch (error) {
					input.setCustomValidity(String(error));
					input.reportValidity();
					status(String(error));
				}
			}),
		);
	}
	private name(value: string): string {
		if (!value.trim() || value.trim().length > 256) {
			this.invalid();
		}
		return value.trim();
	}
	private numeric(value: string, min = -Infinity, max = Infinity): number {
		const number = Number(value);
		if (!value.trim() || !Number.isFinite(number) || number < min || number > max) {
			this.invalid();
		}
		return number;
	}
	private invalid(): never {
		throw new TypeError(
			localize(
				'sessions.design.invalidResourceValue',
				'Enter a valid value. Names must be non-empty and unique; colors use six or eight hex digits.',
			),
		);
	}
}
function unique(base: string, names: readonly string[]): string {
	let name = base;
	let index = 1;
	while (names.includes(name)) {
		name = `${base} ${++index}`;
	}
	return name;
}
function typeLabels(): Record<DesignVariableType, string> {
	return {
		color: localize('sessions.design.colorVariable', 'Color'),
		number: localize('sessions.design.numberVariable', 'Number'),
		string: localize('sessions.design.stringVariable', 'String'),
		boolean: localize('sessions.design.booleanVariable', 'Boolean'),
	};
}
function styleLabels(): Record<DesignStyleKind, string> {
	return {
		fill: localize('sessions.design.fillStyle', 'Paint style'),
		text: localize('sessions.design.textStyle', 'Text style'),
		effect: localize('sessions.design.effectStyle', 'Effect style'),
		grid: localize('sessions.design.gridStyle', 'Layout guide style'),
	};
}

export function designPropertyLabel(property: DesignBindableProperty): string {
	const labels: Record<DesignBindableProperty, string> = {
		fill: localize('sessions.design.fill', 'Fill'),
		width: localize('sessions.design.width', 'Width'),
		height: localize('sessions.design.height', 'Height'),
		opacity: localize('sessions.design.opacity', 'Opacity'),
		visible: localize('sessions.design.visibility', 'Visibility'),
		text: localize('sessions.design.text', 'Text'),
		fontFamily: localize('sessions.design.fontFamily', 'Font family'),
		fontSize: localize('sessions.design.fontSize', 'Font size'),
		fontWeight: localize('sessions.design.fontWeight', 'Font weight'),
		lineHeight: localize('sessions.design.lineHeight', 'Line height'),
		letterSpacing: localize('sessions.design.letterSpacing', 'Letter spacing'),
		strokeWidth: localize('sessions.design.strokeWidth', 'Stroke width'),
		minWidth: localize('sessions.design.minWidth', 'Min width'),
		maxWidth: localize('sessions.design.maxWidth', 'Max width'),
		minHeight: localize('sessions.design.minHeight', 'Min height'),
		maxHeight: localize('sessions.design.maxHeight', 'Max height'),
		gap: localize('sessions.design.gap', 'Gap'),
		crossGap: localize('sessions.design.lineGap', 'Line gap'),
		paddingTop: localize('sessions.design.paddingTop', 'Padding top'),
		paddingRight: localize('sessions.design.paddingRight', 'Padding right'),
		paddingBottom: localize('sessions.design.paddingBottom', 'Padding bottom'),
		paddingLeft: localize('sessions.design.paddingLeft', 'Padding left'),
	};
	return labels[property];
}
function libraryEntries(
	document: DesignDocument,
): Map<
	string,
	{ readonly name: string; readonly value: unknown; readonly description: string; readonly shape?: DesignShape }
> {
	const result = new Map<string, { name: string; value: unknown; description: string; shape?: DesignShape }>();
	const catalog = getDesignResourceCatalog(document.resources);
	const variableName = (id: string): string =>
		catalog.variables.find(variable => variable.id === id)?.name ??
		localize('sessions.design.unavailableResource', 'Unavailable resource (last value retained)');
	for (const collection of catalog.collections) {
		result.set(collection.id, {
			name: collection.name,
			value: collection,
			description: localize(
				'sessions.design.collectionReview',
				'Modes: {0}\nDefault: {1}',
				collection.modes.map(mode => mode.name).join(', '),
				collection.modes.find(mode => mode.id === collection.defaultMode)!.name,
			),
		});
	}
	for (const variable of catalog.variables) {
		const collection = catalog.collections.find(collection => collection.id === variable.collectionId)!;
		result.set(variable.id, {
			name: variable.name,
			value: variable,
			description: [
				typeLabels()[variable.type],
				...collection.modes.map(
					mode =>
						`${mode.name}: ${typeof variable.values[mode.id] === 'object' ? variableName((variable.values[mode.id] as { alias: string }).alias) : variable.values[mode.id]}`,
				),
			].join('\n'),
		});
	}
	for (const style of catalog.styles) {
		const values = Object.entries(style.values).map(([key, value]) =>
			key === 'effects' && Array.isArray(value)
				? localize('sessions.design.effectsReview', 'Effects: {0}', value.map(describeDesignEffect).join('; '))
				: key === 'effects'
					? localize(
							'sessions.design.shadowReview',
							'Shadow: X {0}, Y {1}, blur {2}, color {3}',
							value.x,
							value.y,
							value.blur,
							value.color,
						)
					: key === 'layoutGuide'
						? localize('sessions.design.guideReview', 'Layout guide: {0} px, {1}', value.size, value.color)
						: `${designPropertyLabel(key as DesignBindableProperty)}: ${value}`,
		);
		result.set(style.id, {
			name: style.name,
			value: style,
			description: [
				styleLabels()[style.kind],
				...values,
				...Object.entries(style.bindings ?? {}).map(
					([key, id]) => `${designPropertyLabel(key as DesignBindableProperty)}: ${variableName(id)}`,
				),
			].join('\n'),
		});
	}
	const describe = (shape: DesignShape, depth = 0): string =>
		[
			'  '.repeat(depth) +
				localize(
					'sessions.design.componentLayerReview',
					'{0}: {1} × {2}, fill {3}',
					shape.name || localize('sessions.design.layer', 'Layer'),
					shape.width,
					shape.height,
					shape.fill,
				),
			...Object.keys(designPropertyTypes)
				.filter(
					key =>
						!['width', 'height', 'fill'].includes(key) &&
						getDesignProperty(shape, key as DesignBindableProperty) !== undefined,
				)
				.map(
					key =>
						`${designPropertyLabel(key as DesignBindableProperty)}: ${getDesignProperty(shape, key as DesignBindableProperty)}`,
				),
			...Object.entries(shape.bindings ?? {}).map(
				([key, id]) => `${designPropertyLabel(key as DesignBindableProperty)}: ${variableName(id)}`,
			),
			...Object.entries(shape.styleBindings ?? {}).map(
				([kind, id]) =>
					`${styleLabels()[kind as DesignStyleKind]}: ${catalog.styles.find(style => style.id === id)?.name ?? localize('sessions.design.unavailableResource', 'Unavailable resource (last value retained)')}`,
			),
			...(shape.kind === 'frame' && shape.component?.kind === 'main' && shape.component.variant
				? Object.entries(shape.component.variant).map(([key, value]) => `${key}: ${value}`)
				: []),
			...(shape.kind === 'frame' || shape.kind === 'group'
				? shape.children.map(child => describe(child, depth + 1))
				: []),
		].join('\n');
	for (const shape of flattenDesignShapes(document.shapes)) {
		if (shape.kind === 'frame' && shape.component) {
			result.set(shape.id, {
				name: shape.name || localize('sessions.design.component', 'Component'),
				value: shape,
				description: describe(shape),
				shape,
			});
		}
	}
	return result;
}
