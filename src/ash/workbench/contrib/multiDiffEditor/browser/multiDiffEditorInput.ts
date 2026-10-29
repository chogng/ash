import type { IResourceEditorInput } from '../../../common/editor.js';
import { URI } from '../../../../base/common/uri.js';
import { EditorPaneMatch } from '../../../browser/parts/editor/editorPane.js';
import { EditorInputSerializers, requireRecord, requireSerializedEditorInput, requireString } from '../../../services/editor/common/editorInputSerializer.js';

export const MULTI_DIFF_EDITOR_ID = 'stanza.editor.multiDiff';
export const MULTI_DIFF_EDITOR_CONTENT_TYPE = 'application/vnd.stanza.editor-multi-diff';

EditorInputSerializers.registerStatic({
	typeId: 'workbench.editorInput.multiDiff',
	canSerialize: isMultiDiffEditorInput,
	serialize: (input, registry) => {
		if (!isMultiDiffEditorInput(input)) throw new TypeError('Multi-diff serializer requires a multi-diff input');
		return Object.freeze({
			resource: input.resource.toString(),
			label: input.label,
			items: Object.freeze(input.items.map(item => Object.freeze({
				label: item.label,
				...(item.id === undefined ? {} : { id: item.id }),
				original: registry.serialize(item.original),
				modified: registry.serialize(item.modified),
				...(item.binary === undefined ? {} : { binary: item.binary }),
				...(item.goToFile === undefined ? {} : { goToFile: registry.serialize(item.goToFile) }),
				...(item.actions === undefined ? {} : { actions: item.actions }),
				...(item.contextKeys === undefined ? {} : { contextKeys: item.contextKeys }),
			}))),
			...(input.source === undefined ? {} : { source: input.source }),
		});
	},
	deserialize: (value, registry) => {
		const record = requireRecord(value, 'serialized multi-diff editor input');
		if (!Array.isArray(record.items)) throw new TypeError('Serialized multi-diff editor requires items');
		const items = record.items.map(item => {
			const entry = requireRecord(item, 'serialized multi-diff item');
			return {
				label: requireString(entry.label, 'serialized multi-diff item label'),
				id: entry.id === undefined ? undefined : requireString(entry.id, 'multi-diff item identity'),
				original: registry.deserialize(requireSerializedEditorInput(entry.original, 'serialized multi-diff original input')),
				modified: registry.deserialize(requireSerializedEditorInput(entry.modified, 'serialized multi-diff modified input')),
				...(entry.binary === undefined ? {} : { binary: requireBinary(entry.binary) }),
				...(entry.goToFile === undefined ? {} : { goToFile: registry.deserialize(requireSerializedEditorInput(entry.goToFile, 'serialized multi-diff Open File input')) }),
				...(entry.actions === undefined ? {} : { actions: requireActions(entry.actions) }),
				// The input factory validates this metadata before publishing the comparisons.
				...(entry.contextKeys === undefined ? {} : { contextKeys: entry.contextKeys as Readonly<Record<string, boolean>> }),
			};
		});
		return createMultiDiffEditorInput(
			URI.parse(requireString(record.resource, 'serialized multi-diff resource')),
			items,
			requireString(record.label, 'serialized multi-diff label'),
			record.source === undefined ? undefined : requireMultiDiffSource(record.source),
		);
	},
});

export type MultiDiffEditorSource =
	| { readonly kind: 'snapshot'; readonly label: string; readonly repositoryId?: string; }
	| { readonly kind: 'external'; readonly providerId: string; readonly label: string; readonly repositoryId?: string; readonly branchName?: string; };

export interface MultiDiffCommandAction {
	readonly id: string; readonly label: string; readonly tooltip: string; readonly icon?: string;
	readonly command: string; readonly arguments: readonly unknown[]; readonly enabled?: boolean;
}

export interface MultiDiffEditorInputItem {
	readonly id?: string;
	readonly label: string;
	readonly binary?: boolean;
	readonly original: IResourceEditorInput;
	readonly modified: IResourceEditorInput;
	/** Resource opened by the per-file Open File action. Defaults to the modified side. */
	readonly goToFile?: IResourceEditorInput;
	readonly actions?: readonly MultiDiffCommandAction[];
	/** Provider capabilities are scoped to this file's toolbar. */
	readonly contextKeys?: Readonly<Record<string, boolean>>;
}

export interface MultiDiffEditorInput extends IResourceEditorInput {
	readonly contentType: typeof MULTI_DIFF_EDITOR_CONTENT_TYPE;
	readonly label: string;
	readonly items: readonly MultiDiffEditorInputItem[];
	readonly source?: MultiDiffEditorSource;
}

/** Creates one Workbench tab containing an ordered collection of text comparisons. */
export function createMultiDiffEditorInput(resource: URI, items: readonly MultiDiffEditorInputItem[], label: string, source?: MultiDiffEditorSource): MultiDiffEditorInput {
	if (!resource || typeof resource.toString !== 'function') throw new TypeError('Multi-diff editor input requires a resource identity');
	if (!Array.isArray(items)) throw new TypeError('Multi-diff editor input requires comparisons');
	if (typeof label !== 'string' || label.trim().length === 0) throw new TypeError('Multi-diff editor label must be a non-empty string');
	if (source !== undefined) requireMultiDiffSource(source);
	const keys = new Set<string>();
	const normalizedItems = items.map((item) => {
		if (!item || typeof item !== 'object' || typeof item.label !== 'string' || item.label.trim().length === 0) {
			throw new TypeError('Multi-diff editor items require a non-empty label');
		}
		assertTextResourceInput(item.original, 'Multi-diff original input');
		assertTextResourceInput(item.modified, 'Multi-diff modified input');
		if (item.goToFile !== undefined) assertTextResourceInput(item.goToFile, 'Multi-diff Open File input');
		if (item.actions !== undefined) requireActions(item.actions);
		if (item.binary !== undefined) requireBinary(item.binary);
		const normalized = Object.freeze({
			label: item.label.trim(),
			...(item.id === undefined ? {} : { id: requireString(item.id, 'multi-diff item identity') }),
			original: item.original,
			modified: item.modified,
			...(item.binary === undefined ? {} : { binary: item.binary }),
			...(item.goToFile ? { goToFile: item.goToFile } : {}),
			...(item.actions ? { actions: requireActions(item.actions) } : {}),
			...(item.contextKeys === undefined ? {} : { contextKeys: requireContextKeys(item.contextKeys) }),
		});
		const key = multiDiffEditorItemKey(normalized);
		if (keys.has(key)) throw new TypeError(`Duplicate multi-diff comparison '${normalized.label}'`);
		keys.add(key);
		return normalized;
	});
	return Object.freeze({
		resource,
		contentType: MULTI_DIFF_EDITOR_CONTENT_TYPE,
		items: Object.freeze(normalizedItems),
		label: label.trim(),
		readOnly: normalizedItems.every(item => item.binary || item.modified.readOnly === true),
		showBreadcrumbs: false,
		...(source ? { source: freezeMultiDiffSource(source) } : {}),
	});
}

export function isMultiDiffEditorInput(input: IResourceEditorInput): input is MultiDiffEditorInput {
	return input.contentType === MULTI_DIFF_EDITOR_CONTENT_TYPE &&
		'items' in input &&
		Array.isArray(input.items) &&
		input.items.every((item) => isMultiDiffEditorInputItem(item));
}

export function matchMultiDiffEditor(input: IResourceEditorInput): EditorPaneMatch {
	return isMultiDiffEditorInput(input) ? EditorPaneMatch.Default : EditorPaneMatch.None;
}

export function multiDiffEditorItemKey(item: MultiDiffEditorInputItem): string {
	if (item.id !== undefined) return item.id;
	return `${item.original.resource.toString()}\0${item.modified.resource.toString()}`;
}

function isMultiDiffEditorInputItem(value: unknown): value is MultiDiffEditorInputItem {
	return typeof value === 'object' && value !== null &&
		'label' in value && typeof value.label === 'string' && value.label.trim().length > 0 &&
		'original' in value && isTextResourceInput(value.original) &&
		'modified' in value && isTextResourceInput(value.modified) &&
		(!('goToFile' in value) || value.goToFile === undefined || isTextResourceInput(value.goToFile)) &&
		(!('actions' in value) || value.actions === undefined || Array.isArray(value.actions)) &&
		(!('binary' in value) || value.binary === undefined || typeof value.binary === 'boolean');
}

function requireBinary(value: unknown): boolean {
	if (typeof value !== 'boolean') throw new TypeError('Multi-diff binary state must be boolean');
	return value;
}

export function requireActions(value: unknown): readonly MultiDiffCommandAction[] {
	if (!Array.isArray(value) || value.length > 64) throw new TypeError('Invalid multi-diff actions');
	return Object.freeze(value.map(value => {
		const entry = requireRecord(value, 'multi-diff action');
		if (!Array.isArray(entry.arguments) || entry.arguments.length > 64 || (entry.enabled !== undefined && typeof entry.enabled !== 'boolean')) throw new TypeError('Invalid multi-diff action arguments');
		return Object.freeze({ id: requireString(entry.id, 'action id'), label: requireString(entry.label, 'action label'), tooltip: requireString(entry.tooltip, 'action tooltip'), command: requireString(entry.command, 'action command'), arguments: Object.freeze([...entry.arguments]), ...(entry.icon === undefined ? {} : { icon: requireString(entry.icon, 'action icon') }), ...(entry.enabled === undefined ? {} : { enabled: entry.enabled }) });
	}));
}

function requireContextKeys(value: unknown): Readonly<Record<string, boolean>> {
	const record = requireRecord(value, 'multi-diff context keys');
	if (Object.keys(record).length > 64 || Object.entries(record).some(([key, flag]) => !key || key.length > 128 || typeof flag !== 'boolean')) {
		throw new TypeError('Invalid multi-diff context keys');
	}
	return Object.freeze({ ...record }) as Readonly<Record<string, boolean>>;
}

function requireMultiDiffSource(value: unknown): MultiDiffEditorSource {
	if (!value || typeof value !== 'object' || !('kind' in value)) throw new TypeError('Multi-diff source is invalid');
	const source = value as Partial<MultiDiffEditorSource>;
	// Persisted inputs from the former built-in provider reopen as captured comparisons.
	if ((value as { kind: string; }).kind === 'git' && 'scope' in value && typeof value.scope === 'string') return { kind: 'snapshot', label: value.scope };
	if (source.kind === 'snapshot' && typeof source.label === 'string' && source.label.length > 0 && (source.repositoryId === undefined || typeof source.repositoryId === 'string')) {
		return freezeMultiDiffSource(source as MultiDiffEditorSource);
	}
	if (source.kind === 'external' && typeof source.providerId === 'string' && source.providerId.length > 0 && typeof source.label === 'string' && source.label.length > 0 && (source.repositoryId === undefined || typeof source.repositoryId === 'string') && (source.branchName === undefined || typeof source.branchName === 'string')) {
		return freezeMultiDiffSource(source as MultiDiffEditorSource);
	}
	throw new TypeError('Multi-diff source is invalid');
}

function freezeMultiDiffSource(source: MultiDiffEditorSource): MultiDiffEditorSource {
	return Object.freeze({ ...source });
}

function assertTextResourceInput(value: unknown, owner: string): asserts value is IResourceEditorInput {
	if (!isTextResourceInput(value)) throw new TypeError(`${owner} requires an editor resource`);
}

function isTextResourceInput(value: unknown): value is IResourceEditorInput {
	return typeof value === 'object' && value !== null &&
		'resource' in value &&
		typeof (value as IResourceEditorInput).resource?.toString === 'function';
}
