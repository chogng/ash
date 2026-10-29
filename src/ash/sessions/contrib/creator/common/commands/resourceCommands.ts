import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import { flattenDesignShapes, type DesignAsset, type DesignShape } from '../model/document.js';
import type { DesignModel } from '../model/designModel.js';
import {
	designPropertyTypes,
	designStyleFields,
	emptyDesignResources,
	getDesignResourceCatalog,
	normalizeDesignProperty,
	resolveDesignVariable,
	supportsDesignProperty,
	validateDesignResources,
	type DesignBindableProperty,
	type DesignLibrary,
	type DesignResources,
	type DesignStyle,
	type DesignStyleKind,
	type DesignVariable,
	type DesignVariableType,
	type DesignVariableValue,
} from '../model/designResources.js';

/** Resource edits, reference updates and library acceptance cross one document history boundary. */
export class ResourceCommands {
	constructor(private readonly model: DesignModel) {}
	public get value(): DesignResources {
		return this.model.value.resources ?? emptyDesignResources;
	}
	private commit(resources: DesignResources, edit: (shape: DesignShape) => DesignShape = shape => shape, assets = this.model.value.assets): void {
		validateDesignResources(resources);
		const visit = (shape: DesignShape): DesignShape => {
			const next = edit(shape);
			return next.kind === 'frame' || next.kind === 'group' ? { ...next, children: next.children.map(visit) } : next;
		};
		this.model.applyEdit(this.model.value.shapes.map(visit), assets, resources);
	}
	public addCollection(name: string): string {
		const id = generateUuid();
		const mode = generateUuid();
		this.commit({
			...this.value,
			collections: [
				...this.value.collections,
				{
					id,
					name,
					modes: [{ id: mode, name: localize('sessions.design.defaultMode', 'Default') }],
					defaultMode: mode,
				},
			],
		});
		return id;
	}
	public renameCollection(id: string, name: string): void {
		this.commit({
			...this.value,
			collections: this.value.collections.map(collection => (collection.id === id ? { ...collection, name } : collection)),
		});
	}
	public deleteCollection(id: string): void {
		const removed = new Set(this.value.variables.filter(variable => variable.collectionId === id).map(variable => variable.id));
		this.removeVariables(
			removed,
			{
				...this.value,
				collections: this.value.collections.filter(collection => collection.id !== id),
				modes: omit(this.value.modes, id),
			},
			shape => ({ ...shape, variableModes: omit(shape.variableModes, id) }),
		);
	}
	public addMode(collectionId: string, name: string): string {
		const collection = this.value.collections.find(collection => collection.id === collectionId);
		if (!collection) {
			return '';
		}
		const id = generateUuid();
		this.commit({
			...this.value,
			collections: this.value.collections.map(current => (current.id === collectionId ? { ...current, modes: [...current.modes, { id, name }] } : current)),
			variables: this.value.variables.map(variable =>
				variable.collectionId === collectionId ? { ...variable, values: { ...variable.values, [id]: variable.values[collection.defaultMode] } } : variable,
			),
		});
		return id;
	}
	public renameMode(collectionId: string, id: string, name: string): void {
		this.commit({
			...this.value,
			collections: this.value.collections.map(collection =>
				collection.id === collectionId
					? {
							...collection,
							modes: collection.modes.map(mode => (mode.id === id ? { ...mode, name } : mode)),
						}
					: collection,
			),
		});
	}
	public setDefaultMode(collectionId: string, id: string): void {
		this.commit({
			...this.value,
			collections: this.value.collections.map(collection => (collection.id === collectionId && collection.modes.some(mode => mode.id === id) ? { ...collection, defaultMode: id } : collection)),
		});
	}
	public deleteMode(collectionId: string, id: string): void {
		const collection = this.value.collections.find(collection => collection.id === collectionId);
		if (!collection || collection.modes.length < 2) {
			return;
		}
		const modes = collection.modes.filter(mode => mode.id !== id);
		this.commit(
			{
				...this.value,
				modes: this.value.modes?.[collectionId] === id ? omit(this.value.modes, collectionId) : this.value.modes,
				collections: this.value.collections.map(current =>
					current.id === collectionId
						? {
								...current,
								modes,
								defaultMode: current.defaultMode === id ? modes[0].id : current.defaultMode,
							}
						: current,
				),
				variables: this.value.variables.map(variable => (variable.collectionId === collectionId ? { ...variable, values: omit(variable.values, id) } : variable)),
			},
			shape => (shape.variableModes?.[collectionId] === id ? { ...shape, variableModes: omit(shape.variableModes, collectionId) } : shape),
		);
	}
	public setMode(ids: ReadonlySet<string>, collectionId: string, modeId: string): void {
		const collection = getDesignResourceCatalog(this.value).collections.find(collection => collection.id === collectionId);
		if (!collection || (modeId && !collection.modes.some(mode => mode.id === modeId))) {
			return;
		}
		const update = (modes: Readonly<Record<string, string>> | undefined): Record<string, string> => (modeId ? { ...modes, [collectionId]: modeId } : omit(modes, collectionId));
		if (!ids.size) {
			this.commit({ ...this.value, modes: update(this.value.modes) });
		} else {
			this.commit(this.value, shape => (ids.has(shape.id) ? { ...shape, variableModes: update(shape.variableModes) } : shape));
		}
	}
	public addVariable(collectionId: string, name: string, type: DesignVariableType): string {
		const collection = this.value.collections.find(collection => collection.id === collectionId);
		if (!collection) {
			return '';
		}
		const id = generateUuid();
		const value = type === 'color' ? '#808080' : type === 'number' ? 16 : type === 'boolean' ? true : '';
		this.commit({
			...this.value,
			variables: [
				...this.value.variables,
				{
					id,
					name,
					collectionId,
					type,
					values: Object.fromEntries(collection.modes.map(mode => [mode.id, value])),
				},
			],
		});
		return id;
	}
	public renameVariable(id: string, name: string): void {
		this.commit({
			...this.value,
			variables: this.value.variables.map(variable => (variable.id === id ? { ...variable, name } : variable)),
		});
	}
	public setVariableValue(id: string, mode: string, value: DesignVariableValue): void {
		this.commit({
			...this.value,
			variables: this.value.variables.map(variable => (variable.id === id && Object.hasOwn(variable.values, mode) ? { ...variable, values: { ...variable.values, [mode]: value } } : variable)),
		});
	}
	public deleteVariable(id: string): void {
		this.removeVariables(new Set([id]), this.value);
	}
	private removeVariables(ids: ReadonlySet<string>, resources: DesignResources, edit: (shape: DesignShape) => DesignShape = shape => shape): void {
		// Deleting a dependency also breaks aliases at applied properties. Preserve
		// each layer's materialized value, including layers using different modes.
		const affected = new Set(ids);
		let changed = true;
		while (changed) {
			changed = false;
			for (const variable of this.value.variables) {
				if (!affected.has(variable.id) && Object.values(variable.values).some(value => typeof value === 'object' && affected.has(value.alias))) {
					affected.add(variable.id);
					changed = true;
				}
			}
		}
		const bindings = (values: DesignShape['bindings']): DesignShape['bindings'] => Object.fromEntries(Object.entries(values ?? {}).filter(([, id]) => !affected.has(id)));
		const variables: DesignVariable[] = resources.variables
			.filter(variable => !ids.has(variable.id))
			.map(variable => ({
				...variable,
				values: Object.fromEntries(
					Object.entries(variable.values).map(([mode, value]) => [
						mode,
						typeof value === 'object' && ids.has(value.alias)
							? (resolveDesignVariable(this.value, variable.id, {
									...this.value.modes,
									[variable.collectionId]: mode,
								}) ?? (variable.type === 'number' ? 0 : variable.type === 'boolean' ? false : variable.type === 'color' ? '#000000' : ''))
							: value,
					]),
				),
			}));
		const affectedStyles = new Set(resources.styles.filter(style => Object.values(style.bindings ?? {}).some(id => affected.has(id))).map(style => style.id));
		const styles = resources.styles.map(style => {
			const values = { ...style.values };
			for (const [property, id] of Object.entries(style.bindings ?? {})) {
				if (affected.has(id)) {
					const value = resolveDesignVariable(this.value, id, this.value.modes);
					if (value !== undefined) {
						Reflect.set(values, property, normalizeDesignProperty(property as DesignBindableProperty, value));
					}
				}
			}
			return { ...style, values, bindings: bindings(style.bindings) };
		});
		this.commit({ ...resources, variables, styles }, shape =>
			edit({
				...shape,
				bindings: bindings(shape.bindings),
				styleBindings: Object.fromEntries(Object.entries(shape.styleBindings ?? {}).filter(([, id]) => !affectedStyles.has(id))),
			}),
		);
	}

	public bind(ids: ReadonlySet<string>, property: DesignBindableProperty, variableId: string, inheritStyle = false): void {
		const variable = getDesignResourceCatalog(this.value, true).variables.find(variable => variable.id === variableId);
		if (variableId && (!variable || variable.type !== designPropertyTypes[property])) {
			return;
		}
		this.commit(this.value, shape => {
			if (!ids.has(shape.id) || !supportsDesignProperty(shape, property)) {
				return shape;
			}
			const styles = { ...shape.styleBindings };
			if (!variableId && !inheritStyle) {
				for (const [kind, fields] of Object.entries(designStyleFields)) {
					if ((fields as readonly string[]).includes(property)) {
						Reflect.deleteProperty(styles, kind);
					}
				}
			}
			return {
				...shape,
				styleBindings: styles,
				bindings: variableId ? { ...shape.bindings, [property]: variableId } : omit(shape.bindings, property),
			};
		});
	}
	public createStyle(shape: DesignShape, kind: DesignStyleKind, name: string): string {
		const id = generateUuid();
		const style = this.captureStyle(shape, { id, kind, name, values: {} });
		this.commit({ ...this.value, styles: [...this.value.styles, style] }, current =>
			current.id === shape.id
				? {
						...current,
						styleBindings: { ...current.styleBindings, [kind]: id },
						bindings: Object.fromEntries(Object.entries(current.bindings ?? {}).filter(([key]) => !(designStyleFields[kind] as readonly string[]).includes(key))),
					}
				: current,
		);
		return id;
	}
	private captureStyle(shape: DesignShape, style: DesignStyle): DesignStyle {
		const fields: readonly string[] = designStyleFields[style.kind];
		const defaults =
			style.kind === 'text'
				? {
						fontFamily: 'sans-serif',
						fontSize: shape.kind === 'text' ? shape.fontSize : 16,
						fontWeight: 400,
						letterSpacing: 0,
					}
				: {};
		return {
			...style,
			values: {
				...defaults,
				...Object.fromEntries(fields.filter(key => Reflect.has(shape, key)).map(key => [key, Reflect.get(shape, key)])),
			},
			bindings: Object.fromEntries(Object.entries(shape.bindings ?? {}).filter(([key]) => fields.includes(key))),
		};
	}
	public updateStyle(id: string, shape: DesignShape): void {
		this.commit({
			...this.value,
			styles: this.value.styles.map(style => (style.id === id ? this.captureStyle(shape, style) : style)),
		});
	}
	public renameStyle(id: string, name: string): void {
		this.commit({
			...this.value,
			styles: this.value.styles.map(style => (style.id === id ? { ...style, name } : style)),
		});
	}
	public deleteStyle(id: string): void {
		this.commit({ ...this.value, styles: this.value.styles.filter(style => style.id !== id) }, shape => ({
			...shape,
			styleBindings: Object.fromEntries(Object.entries(shape.styleBindings ?? {}).filter(([, style]) => style !== id)),
		}));
	}
	public applyStyle(ids: ReadonlySet<string>, kind: DesignStyleKind, id: string): void {
		const style = getDesignResourceCatalog(this.value, true).styles.find(style => style.id === id && style.kind === kind);
		if (id && !style) {
			return;
		}
		this.commit(this.value, shape =>
			ids.has(shape.id) && (kind !== 'text' || shape.kind === 'text') && (kind !== 'grid' || shape.kind === 'frame')
				? {
						...shape,
						styleBindings: id ? { ...shape.styleBindings, [kind]: id } : omit(shape.styleBindings, kind),
						...(id
							? {
									bindings: Object.fromEntries(Object.entries(shape.bindings ?? {}).filter(([property]) => !(designStyleFields[kind] as readonly string[]).includes(property))),
								}
							: {}),
					}
				: shape,
		);
	}
	public setLibraryEnabled(id: string, enabled: boolean): void {
		this.commit({
			...this.value,
			libraries: this.value.libraries.map(library => (library.id === id ? { ...library, enabled } : library)),
		});
	}
	public acceptLibrary(library: DesignLibrary): void {
		if (library.id === this.model.value.documentId || library.document.resources?.libraries.length) {
			throw new TypeError(localize('sessions.design.libraryConflict', 'This library contains conflicting resource identities.'));
		}
		const libraries = [...this.value.libraries.filter(current => current.id !== library.id), library];
		const ids = [...this.model.value.shapes, ...libraries.flatMap(current => current.document.shapes)].flatMap(shape => flattenDesignShapes([shape]).map(shape => shape.id));
		if (new Set(ids).size !== ids.length) {
			throw new TypeError(localize('sessions.design.libraryConflict', 'This library contains conflicting resource identities.'));
		}
		const assets = new Map(this.model.value.assets.map(asset => [asset.id, asset]));
		for (const asset of library.document.assets) {
			const old = assets.get(asset.id);
			const versions = new Map(old?.versions.map(version => [version.id, version]));
			for (const version of asset.versions) {
				const previous = versions.get(version.id);
				if (previous && JSON.stringify(previous) !== JSON.stringify(version)) {
					throw new TypeError(localize('sessions.design.libraryConflict', 'This library contains conflicting resource identities.'));
				}
				versions.set(version.id, version);
			}
			assets.set(asset.id, { ...asset, versions: [...versions.values()] });
		}
		this.commit({ ...this.value, libraries }, undefined, [...assets.values()] as readonly DesignAsset[]);
	}
}
function omit<T>(value: Readonly<Record<string, T>> | undefined, key: string): Record<string, T> {
	return Object.fromEntries(Object.entries(value ?? {}).filter(([id]) => id !== key));
}
