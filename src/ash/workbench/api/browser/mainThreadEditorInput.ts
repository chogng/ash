import { URI } from '../../../base/common/uri.js';
import type { IResourceEditorInput } from '../../common/editor.js';
import { createBinaryDiffEditorInput, createDiffEditorInput } from '../../common/editor/diffEditorInput.js';
import { createScmMergeEditorInput } from '../../contrib/scm/browser/scmMergeEditorInput.js';
import { createMultiDiffEditorInput, requireActions, type MultiDiffEditorInputItem } from '../../contrib/multiDiffEditor/browser/multiDiffEditorInput.js';
import type { JsonValue } from '../../../platform/agentHost/common/extensionHostApi.js';
function record(value: JsonValue): Record<string, JsonValue> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError('Expected extension editor object');
	} return value as Record<string, JsonValue>;
}
function text(value: JsonValue, limit = 16 * 1024 * 1024): string {
	if (typeof value !== 'string' || value.length > limit || value.includes('\0')) {
		throw new TypeError('Invalid extension editor text');
	} return value;
}
function optionalText(value: JsonValue | undefined): string | undefined { return value == null ? undefined : text(value); }
function binary(value: JsonValue): boolean {
	if (typeof value !== 'boolean') throw new TypeError('Invalid multi-diff binary state');
	return value;
}
function bytes(value: JsonValue): Uint8Array {
	if (!Array.isArray(value) || value.length > 2 * 1024 * 1024 || value.some(byte => typeof byte !== 'number' || !Number.isInteger(byte) || byte < 0 || byte > 255)) throw new TypeError('Invalid extension editor bytes');
	return Uint8Array.from(value as number[]);
}
export function parseExtensionEditorInput(value: JsonValue): IResourceEditorInput {
	const input = record(value);
	if (input.kind === 'binaryDiff') {
		return createBinaryDiffEditorInput(parseExtensionEditorInput(input.original), parseExtensionEditorInput(input.modified), text(input.label));
	}
	if (input.kind === 'diff') {
		return createDiffEditorInput(parseExtensionEditorInput(input.original), parseExtensionEditorInput(input.modified), text(input.label));
	}
	if (input.kind === 'merge') {
		return createScmMergeEditorInput(text(input.repositoryId), text(input.path), URI.parse(text(input.resource)), URI.parse(text(input.resultResource)));
	}
	if (input.kind === 'multiDiff') {
		if (!Array.isArray(input.items) || input.items.length > 100000) {
			throw new TypeError('Invalid multi-diff resources');
		}
		const items: MultiDiffEditorInputItem[] = input.items.map(value => { const item = record(value); return { id: optionalText(item.id), label: text(item.label), original: parseExtensionEditorInput(item.original), modified: parseExtensionEditorInput(item.modified), ...(item.binary === undefined ? {} : { binary: binary(item.binary) }), actions: item.actions == null ? undefined : requireActions(item.actions), goToFile: item.goToFile == null ? undefined : parseExtensionEditorInput(item.goToFile) }; });
		return createMultiDiffEditorInput(URI.parse(text(input.resource)), items, text(input.label), input.source as unknown as Parameters<typeof createMultiDiffEditorInput>[3]);
	}
	const initialText = optionalText(input.initialText);
	return { resource: URI.parse(text(input.resource)), label: optionalText(input.label), contentType: optionalText(input.contentType), ...(initialText === undefined ? {} : { initialText, readOnly: true }), ...(input.initialBytes === undefined ? {} : { initialBytes: bytes(input.initialBytes), readOnly: true }), ...(input.readOnly === true ? { readOnly: true } : {}) };
}
