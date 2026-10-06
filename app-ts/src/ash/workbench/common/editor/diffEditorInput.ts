import { URI } from "../../../base/common/uri.js";
import { Schemas } from '../../../base/common/network.js';
import { isRemoteResource } from '../../../platform/remote/common/remote.js';
import { isResourceDiffEditorInput, type IResourceDiffEditorInput } from '../editor.js';
import { type EditorInput } from "../../services/editor/common/editorService.js";
import { EditorInputSerializers, requireRecord, requireSerializedEditorInput } from "../../services/editor/common/editorInputSerializer.js";

export const DIFF_EDITOR_ID = "stanza.editor.diff";
export const DIFF_EDITOR_CONTENT_TYPE = "application/vnd.stanza.editor-diff";

EditorInputSerializers.registerStatic({
	typeId: "workbench.editorInput.diff",
	canSerialize: isDiffEditorInput,
	serialize: (input, registry) => {
		if (!isDiffEditorInput(input)) throw new TypeError("Diff editor serializer requires a diff input");
		return Object.freeze({
			original: registry.serialize(input.original),
			modified: registry.serialize(input.modified),
			...(input.label === undefined ? {} : { label: input.label }),
		});
	},
	deserialize: (value, registry) => {
		const record = requireRecord(value, "serialized diff editor input");
		if (record.label !== undefined && typeof record.label !== "string") throw new TypeError("Serialized diff editor label must be a string");
		return createDiffEditorInput(
			registry.deserialize(requireSerializedEditorInput(record.original, "serialized diff original input")),
			registry.deserialize(requireSerializedEditorInput(record.modified, "serialized diff modified input")),
			record.label as string | undefined,
		);
	},
});

/** One Workbench input that compares two ordinary text-resource editor inputs. */
export interface DiffEditorInput extends EditorInput, IResourceDiffEditorInput {
	readonly contentType: typeof DIFF_EDITOR_CONTENT_TYPE;
}

/** Creates a stable synthetic tab identity for an original/modified comparison. */
export function createDiffEditorInput(original: EditorInput, modified: EditorInput, label?: string): DiffEditorInput {
	assertTextResourceInput(original, "Diff original input");
	assertTextResourceInput(modified, "Diff modified input");
	if (label !== undefined && (typeof label !== "string" || label.trim().length === 0)) {
		throw new TypeError("Diff editor label must be a non-empty string");
	}
	const resource = URI.parse(`ash-diff:/compare?original=${encodeURIComponent(original.resource.toString())}&modified=${encodeURIComponent(modified.resource.toString())}`);
	return Object.freeze({
		resource,
		contentType: DIFF_EDITOR_CONTENT_TYPE,
		original,
		modified,
		...(label === undefined ? {} : { label: label.trim() }),
		readOnly: true,
	});
}

/** Narrows a generic Workbench editor input to the two-resource diff contract. */
export function isDiffEditorInput(input: EditorInput): input is DiffEditorInput {
	return input.contentType === DIFF_EDITOR_CONTENT_TYPE &&
		isResourceDiffEditorInput(input);
}

function assertTextResourceInput(value: unknown, owner: string): asserts value is EditorInput {
	if (!isTextResourceInput(value)) throw new TypeError(`${owner} requires an editor resource`);
}

function isTextResourceInput(value: unknown): value is EditorInput {
	return typeof value === "object" && value !== null &&
		"resource" in value &&
		typeof (value as EditorInput).resource?.toString === "function";
}

export const BINARY_DIFF_EDITOR_CONTENT_TYPE = "application/vnd.ash.binary-diff";

export interface BinaryDiffEditorInput extends EditorInput, IResourceDiffEditorInput {
	readonly contentType: typeof BINARY_DIFF_EDITOR_CONTENT_TYPE;
}

/** Compares two file resources without decoding their contents as text. */
export function createBinaryDiffEditorInput(original: EditorInput, modified: EditorInput, label?: string): BinaryDiffEditorInput {
	if (!canReadBinary(original) || !canReadBinary(modified)) {
		throw new TypeError("Binary comparison requires two file resources");
	}
	const resource = URI.parse(`ash-binary-diff:/compare?original=${encodeURIComponent(original.resource.toString())}&modified=${encodeURIComponent(modified.resource.toString())}`);
	return Object.freeze({
		resource,
		contentType: BINARY_DIFF_EDITOR_CONTENT_TYPE,
		original,
		modified,
		label: label ?? `${original.label ?? original.resource.path} ↔ ${modified.label ?? modified.resource.path}`,
		readOnly: true,
	});
}

export function isBinaryDiffEditorInput(input: EditorInput): input is BinaryDiffEditorInput {
	return input.contentType === BINARY_DIFF_EDITOR_CONTENT_TYPE &&
		isResourceDiffEditorInput(input) &&
		canReadBinary(input.original) && canReadBinary(input.modified);
}

EditorInputSerializers.registerStatic({
	typeId: "workbench.editorInput.binaryDiff",
	canSerialize: isBinaryDiffEditorInput,
	serialize: (input, registry) => {
		if (!isBinaryDiffEditorInput(input)) throw new TypeError("Binary diff serializer requires a binary comparison");
		return {
			original: registry.serialize(input.original),
			modified: registry.serialize(input.modified),
			label: input.label,
		};
	},
	deserialize: (value, registry) => {
		const record = requireRecord(value, "serialized binary comparison");
		if (record.label !== undefined && typeof record.label !== "string") {
			throw new TypeError("Serialized binary comparison label must be a string");
		}
		return createBinaryDiffEditorInput(
			registry.deserialize(requireSerializedEditorInput(record.original, "binary original")),
			registry.deserialize(requireSerializedEditorInput(record.modified, "binary modified")),
			record.label as string | undefined,
		);
	},
});

function canReadBinary(value: unknown): value is EditorInput {
	if (typeof value !== "object" || value === null || !("resource" in value)) return false;
	const resource = (value as EditorInput).resource;
	return resource instanceof URI && (resource.scheme === Schemas.file || isRemoteResource(resource));
}
