import { parseDesignEffects, type DesignEffects } from './designEffects.js';
import { parseDesignPaints, designPaints, withDesignPaintColor, type DesignPaint } from './designPaint.js';
import { designTextStyleKeys, parseDesignTextStyle, updateDesignText, type DesignTextStyle } from './designText.js';
import { localize } from '../../../../../nls.js';
import { isRecord } from '../../../../../base/common/types.js';
import { isUuid } from '../../../../../base/common/uuid.js';
import type { DesignDocument, DesignShape } from './document.js';

export type DesignVariableType = 'color' | 'number' | 'string' | 'boolean';
export type DesignVariableValue = string | number | boolean | { readonly alias: string; };
export interface DesignVariableCollection { readonly id: string; readonly name: string; readonly modes: readonly { readonly id: string; readonly name: string; }[]; readonly defaultMode: string; }
export interface DesignVariable { readonly id: string; readonly name: string; readonly collectionId: string; readonly type: DesignVariableType; readonly values: Readonly<Record<string, DesignVariableValue>>; }
export const designPropertyTypes = {
	fill: 'color',
	width: 'number',
	height: 'number',
	opacity: 'number',
	visible: 'boolean',
	text: 'string',
	fontFamily: 'string',
	fontSize: 'number',
	fontWeight: 'number',
	lineHeight: 'number',
	letterSpacing: 'number',
	strokeWidth: 'number',
	minWidth: 'number',
	maxWidth: 'number',
	minHeight: 'number',
	maxHeight: 'number',
	gap: 'number',
	crossGap: 'number',
	paddingTop: 'number',
	paddingRight: 'number',
	paddingBottom: 'number',
	paddingLeft: 'number',
} as const;
export type DesignBindableProperty = keyof typeof designPropertyTypes;
export type DesignBindings = Partial<Readonly<Record<DesignBindableProperty, string>>>;
export type DesignStyleKind = 'fill' | 'text' | 'effect' | 'grid';

export interface DesignLayoutGuide { readonly size: number; readonly color: string; }
export interface DesignStyleValues extends DesignTextStyle { readonly fills?: readonly DesignPaint[]; readonly effects?: DesignEffects; readonly layoutGuide?: DesignLayoutGuide; }
export interface DesignStyle { readonly id: string; readonly name: string; readonly kind: DesignStyleKind; readonly values: DesignStyleValues; readonly bindings?: DesignBindings; }
/** Accepted library versions are immutable document snapshots, separate from the publisher's working file. */
export interface DesignLibrary { readonly id: string; readonly name: string; readonly uri: string; readonly version: string; readonly enabled: boolean; readonly document: DesignDocument; }
export interface DesignResources {
	readonly collections: readonly DesignVariableCollection[];
	readonly variables: readonly DesignVariable[];
	readonly styles: readonly DesignStyle[];
	readonly libraries: readonly DesignLibrary[];
	readonly modes?: Readonly<Record<string, string>>;
}
export const emptyDesignResources: DesignResources = Object.freeze({ collections: Object.freeze([]), variables: Object.freeze([]), styles: Object.freeze([]), libraries: Object.freeze([]) });
export const designStyleFields = { fill: ['fill', 'fills'], text: designTextStyleKeys.filter(key => key !== 'fill' && key !== 'textAlign' && key !== 'textDirection'), effect: ['effects'], grid: ['layoutGuide'] } as const;
const color = (value: unknown): value is string => typeof value === 'string' && /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/iu.test(value);
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const name = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 256;
const keys = (value: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(value).every(key => allowed.includes(key));
function fail(): never { throw new TypeError(localize('sessions.design.invalidResources', 'Invalid design resource, binding, or circular variable alias.')); }
export function freezeDesignResources<T>(value: T): T {
	if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const child of Object.values(value)) { freezeDesignResources(child); } Object.freeze(value); }
	return value;
}

export function getDesignResourceCatalog(resources: DesignResources = emptyDesignResources, enabledOnly = false): Pick<DesignResources, 'collections' | 'variables' | 'styles'> {
	const libraries = resources.libraries.filter(library => !enabledOnly || library.enabled);
	return {
		collections: [...resources.collections, ...libraries.flatMap(library => library.document.resources?.collections ?? [])],
		variables: [...resources.variables, ...libraries.flatMap(library => library.document.resources?.variables ?? [])],
		styles: [...resources.styles, ...libraries.flatMap(library => library.document.resources?.styles ?? [])],
	};
}
export function getDesignLibraryShapes(resources: DesignResources = emptyDesignResources, enabledOnly = false): readonly DesignShape[] { return resources.libraries.filter(library => !enabledOnly || library.enabled).flatMap(library => library.document.shapes); }

export function supportsDesignProperty(shape: DesignShape, property: DesignBindableProperty): boolean {
	if (['text', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing'].includes(property)) { return shape.kind === 'text'; }
	if (property === 'strokeWidth') { return shape.kind === 'path'; }
	if (['gap', 'crossGap', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'].includes(property)) { return shape.kind === 'frame' && !!shape.autoLayout; }
	if (['width', 'height', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight'].includes(property)) { return shape.kind !== 'group'; }
	return true;
}
export function getDesignProperty(shape: DesignShape, property: DesignBindableProperty): unknown {
	if (property === 'fill' && shape.fills) { const paint = designPaints(shape)[0]; return paint?.type === 'solid' ? paint.color : paint?.stops[0].color; }
	if (['minWidth', 'maxWidth', 'minHeight', 'maxHeight'].includes(property)) { return Reflect.get(shape.sizeLimits ?? {}, property); }
	if (shape.kind === 'frame' && shape.autoLayout) {
		if (property === 'gap' || property === 'crossGap') { return shape.autoLayout[property] ?? shape.autoLayout.gap; }
		if (property.startsWith('padding')) { return Reflect.get(shape.autoLayout.padding, property.slice(7).toLowerCase()); }
	}
	return Reflect.get(shape, property);
}
export function normalizeDesignProperty(property: DesignBindableProperty, value: string | number | boolean): string | number | boolean {
	if (typeof value === 'number') {
		if (property === 'opacity') { value = Math.max(0, Math.min(1, value)); }
		else if (property === 'fontWeight') { value = Math.max(1, Math.min(1000, value)); }
		else if (property !== 'letterSpacing') { value = Math.max(['width', 'height', 'fontSize', 'lineHeight', 'strokeWidth', 'maxWidth', 'maxHeight'].includes(property) ? 0.001 : 0, value); }
	}
	return value;
}

export function setDesignProperty(shape: DesignShape, property: DesignBindableProperty, value: string | number | boolean): DesignShape {
	if (!supportsDesignProperty(shape, property)) { return shape; }
	value = normalizeDesignProperty(property, value);
	if (property === 'fill' && shape.fills && typeof value === 'string') { return withDesignPaintColor(shape, undefined, undefined, value); }
	if (['minWidth', 'maxWidth', 'minHeight', 'maxHeight'].includes(property)) { return { ...shape, sizeLimits: { ...shape.sizeLimits, [property]: value } }; }
	if (shape.kind === 'frame' && shape.autoLayout) {
		if (property === 'gap' || property === 'crossGap') { return { ...shape, autoLayout: { ...shape.autoLayout, [property]: value } }; }
		if (property.startsWith('padding')) { return { ...shape, autoLayout: { ...shape.autoLayout, padding: { ...shape.autoLayout.padding, [property.slice(7).toLowerCase()]: value } } }; }
	}
	if (shape.kind === 'text' && property === 'text' && typeof value === 'string') { return updateDesignText(shape, value); }
	return { ...shape, [property]: value } as DesignShape;
}

/** Mode inheritance follows the layer tree. Aliases select the target collection's active mode. */
export function resolveDesignVariable(resources: DesignResources, id: string, modes: Readonly<Record<string, string>> = {}, active = new Set<string>(), overrides: Readonly<Record<string, string | number | boolean>> = {}): string | number | boolean | undefined {
	const catalog = getDesignResourceCatalog(resources);
	const variable = catalog.variables.find(variable => variable.id === id);
	if (!variable) { return undefined; } // Deleted published resources keep the last materialized appearance.
	if (active.has(id)) { fail(); }
	const collection = catalog.collections.find(collection => collection.id === variable.collectionId)!;
	if (Object.hasOwn(overrides, id)) { return overrides[id]; }
	const mode = modes[collection.id];
	const value = variable.values[collection.modes.some(candidate => candidate.id === mode) ? mode : collection.defaultMode];
	if (typeof value !== 'object') { return value; }
	active.add(id);
	const result = resolveDesignVariable(resources, value.alias, modes, active, overrides);
	active.delete(id);
	return result;
}
export function resolveDesignResources(shapes: readonly DesignShape[], resources: DesignResources = emptyDesignResources, overrides: Readonly<Record<string, string | number | boolean>> = {}): readonly DesignShape[] {
	const catalog = getDesignResourceCatalog(resources);
	const visit = (shape: DesignShape, inherited: Readonly<Record<string, string>>): DesignShape => {
		const modes = { ...inherited, ...shape.variableModes };
		let next = shape;
		for (const [kind, id] of Object.entries(shape.styleBindings ?? {})) {
			const style = catalog.styles.find(style => style.id === id && style.kind === kind);
			if (!style) { continue; }
			next = { ...next };
			for (const field of designStyleFields[style.kind]) { if (Reflect.has(style.values, field)) { Reflect.set(next, field, Reflect.get(style.values, field)); } else { Reflect.deleteProperty(next, field); } }
			for (const [property, variable] of Object.entries(style.bindings ?? {})) {
				const value = resolveDesignVariable(resources, variable, modes, undefined, overrides);
				if (value !== undefined) { next = setDesignProperty(next, property as DesignBindableProperty, value); }
			}
		}
		for (const [property, id] of Object.entries(shape.bindings ?? {})) {
			const value = resolveDesignVariable(resources, id, modes, undefined, overrides);
			if (value !== undefined) { next = setDesignProperty(next, property as DesignBindableProperty, value); }
		}
		if (next.kind === 'text' && next.textRuns?.some(run => run.styleId)) {
			next = {
				...next, textRuns: next.textRuns.map(run => {
					const source = catalog.styles.find(style => style.id === run.styleId && style.kind === 'text');
					if (!source) { return run; }
					const style = { ...run.style };
					for (const key of designStyleFields.text) {
						if (run.overrides?.includes(key)) { continue; }
						if (source.values[key] === undefined) { Reflect.deleteProperty(style, key); } else { Reflect.set(style, key, source.values[key]); }
					}
					for (const [key, id] of Object.entries(source.bindings ?? {})) {
						if (run.overrides?.includes(key as keyof DesignTextStyle)) { continue; }
						const value = resolveDesignVariable(resources, id, modes, undefined, overrides);
						if (value !== undefined) { Reflect.set(style, key, normalizeDesignProperty(key as DesignBindableProperty, value)); }
					}
					return { ...run, style };
				})
			};
		}
		// A mode can independently resolve minimum and maximum to crossing values.
		// Keep the declared bindings; the effective maximum cannot be below the minimum.
		if (next.sizeLimits) {
			const limits = { ...next.sizeLimits };
			if (limits.minWidth !== undefined && limits.maxWidth !== undefined) { limits.maxWidth = Math.max(limits.minWidth, limits.maxWidth); }
			if (limits.minHeight !== undefined && limits.maxHeight !== undefined) { limits.maxHeight = Math.max(limits.minHeight, limits.maxHeight); }
			next = { ...next, sizeLimits: limits };
		}
		return next.kind === 'frame' || next.kind === 'group' ? { ...next, children: next.children.map(child => visit(child, modes)) } : next;
	};
	return shapes.map(shape => visit(shape, resources.modes ?? {}));
}

/** Direct property edits detach their binding/style. Resolving a resource never passes through this edit detector. */
export function recordDesignResourceEdits(shapes: readonly DesignShape[], previous: readonly DesignShape[]): readonly DesignShape[] {
	const before = new Map<string, DesignShape>();
	const collect = (shape: DesignShape): void => { before.set(shape.id, shape); if (shape.kind === 'frame' || shape.kind === 'group') { shape.children.forEach(collect); } }; previous.forEach(collect);
	const visit = (shape: DesignShape): DesignShape => {
		const old = before.get(shape.id);
		let next = shape;
		if (old) {
			if (shape.bindings === old.bindings && shape.bindings) { next = { ...next, bindings: Object.fromEntries(Object.entries(shape.bindings).filter(([key]) => JSON.stringify(getDesignProperty(shape, key as DesignBindableProperty)) === JSON.stringify(getDesignProperty(old, key as DesignBindableProperty)))) }; }
			if (shape.styleBindings === old.styleBindings && shape.styleBindings) { next = { ...next, styleBindings: Object.fromEntries(Object.entries(shape.styleBindings).filter(([kind]) => designStyleFields[kind as DesignStyleKind].every(field => JSON.stringify(Reflect.get(shape, field)) === JSON.stringify(Reflect.get(old, field))))) }; }
		}
		return next.kind === 'frame' || next.kind === 'group' ? { ...next, children: next.children.map(visit) } : next;
	};
	return shapes.map(visit);
}

/** Validate only at the persistence boundary, then keep typed commands inside the owner. */
export function parseDesignResourceProperties(value: Record<string, unknown>): Partial<DesignShape> {
	if (value.opacity !== undefined && (!number(value.opacity) || value.opacity < 0 || value.opacity > 1)) { fail(); }
	if (value.visible !== undefined && typeof value.visible !== 'boolean') { fail(); }
	if (value.fontFamily !== undefined && (value.kind !== 'text' || typeof value.fontFamily !== 'string')) { fail(); }
	for (const key of ['fontWeight', 'lineHeight', 'letterSpacing']) { if (value[key] !== undefined && (value.kind !== 'text' || !number(value[key]) || (key === 'fontWeight' && value[key] <= 0) || (key === 'lineHeight' && (value[key] as number) < 0) || (key === 'fontWeight' && value[key] > 1000))) { fail(); } }
	if (value.effects !== undefined) { parseDesignEffects(value.effects); }
	if (value.layoutGuide !== undefined && (value.kind !== 'frame' || !isRecord(value.layoutGuide) || !keys(value.layoutGuide, ['size', 'color']) || !number(value.layoutGuide.size) || value.layoutGuide.size <= 0 || !color(value.layoutGuide.color))) { fail(); }
	if (value.bindings !== undefined && (!isRecord(value.bindings) || Object.entries(value.bindings).some(([property, id]) => !Object.hasOwn(designPropertyTypes, property) || !isUuid(id) || !supportsDesignProperty(value as unknown as DesignShape, property as DesignBindableProperty)))) { fail(); }
	if (value.styleBindings !== undefined && (!isRecord(value.styleBindings) || Object.entries(value.styleBindings).some(([kind, id]) => !Object.hasOwn(designStyleFields, kind) || !isUuid(id) || (kind === 'text' && value.kind !== 'text') || (kind === 'grid' && value.kind !== 'frame')))) { fail(); }
	if (value.variableModes !== undefined && (!isRecord(value.variableModes) || Object.entries(value.variableModes).some(([id, mode]) => !isUuid(id) || !isUuid(mode)))) { fail(); }
	return Object.fromEntries(Object.entries(value).filter(([key]) => resourceShapeKeys.includes(key))) as Partial<DesignShape>;
}
export const resourceShapeKeys = ['opacity', 'visible', 'fontFamily', 'fontWeight', 'lineHeight', 'letterSpacing', 'effects', 'layoutGuide', 'bindings', 'styleBindings', 'variableModes'];

export function parseDesignResources(value: unknown, readLibraryDocument: (value: unknown) => DesignDocument): DesignResources {
	if (!isRecord(value) || !keys(value, ['collections', 'variables', 'styles', 'libraries', 'modes']) || !Array.isArray(value.collections) || !Array.isArray(value.variables) || !Array.isArray(value.styles) || !Array.isArray(value.libraries)) { fail(); }
	const collections = value.collections.map((entry: unknown): DesignVariableCollection => {
		if (!isRecord(entry) || !keys(entry, ['id', 'name', 'modes', 'defaultMode']) || !isUuid(entry.id) || !name(entry.name) || !Array.isArray(entry.modes) || !entry.modes.length || !isUuid(entry.defaultMode)) { fail(); }
		const modes = entry.modes.map((mode: unknown) => { if (!isRecord(mode) || !keys(mode, ['id', 'name']) || !isUuid(mode.id) || !name(mode.name)) { fail(); } return { id: mode.id, name: mode.name }; });
		if (new Set(modes.map(mode => mode.id)).size !== modes.length || new Set(modes.map(mode => mode.name)).size !== modes.length || !modes.some(mode => mode.id === entry.defaultMode)) { fail(); }
		return { id: entry.id, name: entry.name, modes, defaultMode: entry.defaultMode };
	});
	const variables = value.variables.map((entry: unknown): DesignVariable => {
		if (!isRecord(entry) || !keys(entry, ['id', 'name', 'collectionId', 'type', 'values']) || !isUuid(entry.id) || !name(entry.name) || !isUuid(entry.collectionId) || !['color', 'number', 'string', 'boolean'].includes(entry.type as string) || !isRecord(entry.values)) { fail(); }
		for (const [id, val] of Object.entries(entry.values)) { if (!isUuid(id) || !(isRecord(val) ? keys(val, ['alias']) && isUuid(val.alias) : entry.type === 'color' ? color(val) : entry.type === 'number' ? number(val) : entry.type === 'string' ? typeof val === 'string' : typeof val === 'boolean')) { fail(); } }
		return entry as unknown as DesignVariable;
	});
	const styles = value.styles.map((entry: unknown): DesignStyle => {
		if (!isRecord(entry) || !keys(entry, ['id', 'name', 'kind', 'values', 'bindings']) || !isUuid(entry.id) || !name(entry.name) || !Object.hasOwn(designStyleFields, entry.kind as string) || !isRecord(entry.values) || !keys(entry.values, designStyleFields[entry.kind as DesignStyleKind])) { fail(); }
		const values = entry.values;
		if (entry.kind === 'text') { parseDesignTextStyle(values); }
		parseDesignResourceProperties({ ...values, kind: entry.kind === 'text' ? 'text' : 'frame', bindings: entry.bindings });
		if (values.fill !== undefined && !color(values.fill)) { fail(); }
		if (values.fills !== undefined) { parseDesignPaints(values.fills); }
		if (values.fontSize !== undefined && (!number(values.fontSize) || values.fontSize <= 0)) { fail(); }
		if (entry.bindings && Object.keys(entry.bindings).some(key => !(designStyleFields[entry.kind as DesignStyleKind] as readonly string[]).includes(key))) { fail(); }
		return entry as unknown as DesignStyle;
	});
	const libraries = value.libraries.map((entry: unknown): DesignLibrary => {
		if (!isRecord(entry) || !keys(entry, ['id', 'name', 'uri', 'version', 'enabled', 'document']) || !isUuid(entry.id) || !name(entry.name) || typeof entry.uri !== 'string' || !entry.uri || typeof entry.version !== 'string' || !/^[a-f0-9]{64}$/u.test(entry.version) || typeof entry.enabled !== 'boolean') { fail(); }
		const document = readLibraryDocument(entry.document);
		if (document.documentId !== entry.id || document.resources?.libraries.length) { fail(); }
		return { id: entry.id, name: entry.name, uri: entry.uri, version: entry.version, enabled: entry.enabled, document };
	});
	if (value.modes !== undefined && (!isRecord(value.modes) || Object.entries(value.modes).some(([id, mode]) => !isUuid(id) || !isUuid(mode)))) { fail(); }
	const resources: DesignResources = { collections, variables, styles, libraries, ...(value.modes ? { modes: value.modes as Record<string, string> } : {}) };
	validateDesignResources(resources);
	return resources;
}
export function validateDesignResources(resources: DesignResources): void {
	const catalog = getDesignResourceCatalog(resources);
	const ids = [...catalog.collections, ...catalog.variables, ...catalog.styles, ...resources.libraries].map(value => value.id);
	if (new Set(ids).size !== ids.length) { fail(); }
	for (const collection of catalog.collections) {
		const variables = catalog.variables.filter(variable => variable.collectionId === collection.id);
		if (new Set(variables.map(variable => variable.name)).size !== variables.length) { fail(); }
	}
	for (const variable of catalog.variables) {
		const collection = catalog.collections.find(collection => collection.id === variable.collectionId);
		if (!collection || collection.modes.length !== Object.keys(variable.values).length || collection.modes.some(mode => !Object.hasOwn(variable.values, mode.id))) { fail(); }
		for (const value of Object.values(variable.values)) {
			if (typeof value === 'object') { const target = catalog.variables.find(candidate => candidate.id === value.alias); if (target && target.type !== variable.type) { fail(); } }
		}
	}
	// Checking all alias edges prevents cycles across collections and mode combinations.
	const active = new Set<string>(); const visited = new Set<string>();
	const visit = (id: string): void => { if (active.has(id)) { fail(); } if (visited.has(id)) { return; } active.add(id); const variable = catalog.variables.find(variable => variable.id === id); for (const value of Object.values(variable?.values ?? {})) { if (typeof value === 'object') { visit(value.alias); } } active.delete(id); visited.add(id); };
	catalog.variables.forEach(variable => visit(variable.id));
	for (const style of catalog.styles) { for (const [key, id] of Object.entries(style.bindings ?? {})) { const variable = catalog.variables.find(variable => variable.id === id); if (variable && variable.type !== designPropertyTypes[key as DesignBindableProperty]) { fail(); } } }
}
export function validateDesignShapeResources(shapes: readonly DesignShape[], resources: DesignResources = emptyDesignResources): void {
	const catalog = getDesignResourceCatalog(resources);
	const visit = (shape: DesignShape): void => {
		for (const [key, id] of Object.entries(shape.bindings ?? {})) { const variable = catalog.variables.find(variable => variable.id === id); if (variable && variable.type !== designPropertyTypes[key as DesignBindableProperty]) { fail(); } }
		for (const [kind, id] of Object.entries(shape.styleBindings ?? {})) { const style = catalog.styles.find(style => style.id === id); if (style && style.kind !== kind) { fail(); } }
		if (shape.kind === 'frame' || shape.kind === 'group') { shape.children.forEach(visit); }
	}; shapes.forEach(visit);
}
