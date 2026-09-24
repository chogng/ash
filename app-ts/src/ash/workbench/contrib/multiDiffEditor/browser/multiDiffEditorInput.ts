import { URI } from '../../../../base/common/uri.js';
import { type EditorInput } from '../../../browser/parts/editor/editorInput.js';
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
				original: registry.serialize(item.original),
				modified: registry.serialize(item.modified),
				...(item.goToFile === undefined ? {} : { goToFile: registry.serialize(item.goToFile) }),
				...(item.gitChange === undefined ? {} : { gitChange: item.gitChange }),
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
				original: registry.deserialize(requireSerializedEditorInput(entry.original, 'serialized multi-diff original input')),
				modified: registry.deserialize(requireSerializedEditorInput(entry.modified, 'serialized multi-diff modified input')),
				...(entry.goToFile === undefined ? {} : { goToFile: registry.deserialize(requireSerializedEditorInput(entry.goToFile, 'serialized multi-diff Open File input')) }),
				...(entry.gitChange === undefined ? {} : { gitChange: requireGitChange(entry.gitChange) }),
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

export type GitMultiDiffScope = 'staged' | 'unstaged' | 'uncommitted';

export type MultiDiffEditorSource =
	| {
		readonly kind: 'git';
		readonly repositoryId: string;
		readonly scope: GitMultiDiffScope;
		readonly branchName: string | undefined;
	}
	| {
		readonly kind: 'turn';
		readonly sessionId: string;
		readonly threadId: string;
		readonly changeSetIds: readonly string[];
		readonly repositoryId: string;
		readonly targetBranch: string | undefined;
		readonly scope: 'currentTurn' | 'throughCurrentTurn' | 'previousTurn';
	};

export interface MultiDiffEditorGitChange {
	readonly repositoryId: string;
	readonly path: string;
	readonly staged: boolean;
	readonly hasWorktreeChanges: boolean;
}

export interface MultiDiffEditorInputItem {
	readonly label: string;
	readonly original: EditorInput;
	readonly modified: EditorInput;
	/** Resource opened by the per-file Open File action. Defaults to the modified side. */
	readonly goToFile?: EditorInput;
	readonly gitChange?: MultiDiffEditorGitChange;
}

export interface MultiDiffEditorInput extends EditorInput {
	readonly contentType: typeof MULTI_DIFF_EDITOR_CONTENT_TYPE;
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
		if (item.gitChange !== undefined) requireGitChange(item.gitChange);
		const normalized = Object.freeze({
			label: item.label.trim(),
			original: item.original,
			modified: item.modified,
			...(item.goToFile ? { goToFile: item.goToFile } : {}),
			...(item.gitChange ? { gitChange: Object.freeze({ ...item.gitChange }) } : {}),
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
		readOnly: true,
		...(source ? { source: freezeMultiDiffSource(source) } : {}),
	});
}

export function isMultiDiffEditorInput(input: EditorInput): input is MultiDiffEditorInput {
	return input.contentType === MULTI_DIFF_EDITOR_CONTENT_TYPE &&
		'items' in input &&
		Array.isArray(input.items) &&
		input.items.every((item) => isMultiDiffEditorInputItem(item));
}

export function matchMultiDiffEditor(input: EditorInput): EditorPaneMatch {
	return isMultiDiffEditorInput(input) ? EditorPaneMatch.Default : EditorPaneMatch.None;
}

export function multiDiffEditorItemKey(item: MultiDiffEditorInputItem): string {
	return `${item.original.resource.toString()}\0${item.modified.resource.toString()}`;
}

function isMultiDiffEditorInputItem(value: unknown): value is MultiDiffEditorInputItem {
	return typeof value === 'object' && value !== null &&
		'label' in value && typeof value.label === 'string' && value.label.trim().length > 0 &&
		'original' in value && isTextResourceInput(value.original) &&
		'modified' in value && isTextResourceInput(value.modified) &&
		(!('goToFile' in value) || value.goToFile === undefined || isTextResourceInput(value.goToFile)) &&
		(!('gitChange' in value) || value.gitChange === undefined || isGitChange(value.gitChange));
}

function requireGitChange(value: unknown): MultiDiffEditorGitChange {
	if (!isGitChange(value)) throw new TypeError('Multi-diff Git change metadata is invalid');
	return Object.freeze({ ...value });
}

function isGitChange(value: unknown): value is MultiDiffEditorGitChange {
	return typeof value === 'object' && value !== null &&
		'repositoryId' in value && typeof value.repositoryId === 'string' && value.repositoryId.length > 0 &&
		'path' in value && typeof value.path === 'string' && value.path.length > 0 &&
		'staged' in value && typeof value.staged === 'boolean' &&
		'hasWorktreeChanges' in value && typeof value.hasWorktreeChanges === 'boolean';
}

function requireMultiDiffSource(value: unknown): MultiDiffEditorSource {
	if (!value || typeof value !== 'object' || !('kind' in value)) throw new TypeError('Multi-diff source is invalid');
	const source = value as Partial<MultiDiffEditorSource>;
	if (source.kind === 'git' && typeof source.repositoryId === 'string' && source.repositoryId.length > 0 && (source.scope === 'staged' || source.scope === 'unstaged' || source.scope === 'uncommitted') && (source.branchName === undefined || typeof source.branchName === 'string')) {
		return freezeMultiDiffSource(source as MultiDiffEditorSource);
	}
	if (source.kind === 'turn' && typeof source.sessionId === 'string' && source.sessionId.length > 0 && typeof source.threadId === 'string' && source.threadId.length > 0 && Array.isArray(source.changeSetIds) && source.changeSetIds.every(id => typeof id === 'string' && id.length > 0) && typeof source.repositoryId === 'string' && source.repositoryId.length > 0 && (source.targetBranch === undefined || typeof source.targetBranch === 'string') && (source.scope === 'currentTurn' || source.scope === 'throughCurrentTurn' || source.scope === 'previousTurn')) {
		return freezeMultiDiffSource(source as MultiDiffEditorSource);
	}
	throw new TypeError('Multi-diff source is invalid');
}

function freezeMultiDiffSource(source: MultiDiffEditorSource): MultiDiffEditorSource {
	return source.kind === 'turn'
		? Object.freeze({ ...source, changeSetIds: Object.freeze([...source.changeSetIds]) })
		: Object.freeze({ ...source });
}

function assertTextResourceInput(value: unknown, owner: string): asserts value is EditorInput {
	if (!isTextResourceInput(value)) throw new TypeError(`${owner} requires an editor resource`);
}

function isTextResourceInput(value: unknown): value is EditorInput {
	return typeof value === 'object' && value !== null &&
		'resource' in value &&
		typeof (value as EditorInput).resource?.toString === 'function';
}
