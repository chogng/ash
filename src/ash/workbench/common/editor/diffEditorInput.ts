import { URI } from "../../../base/common/uri.js";
import { Schemas } from '../../../base/common/network.js';
import { isRemoteResource } from '../../../platform/remote/common/remote.js';
import { isResourceDiffEditorInput, type IResourceDiffEditorInput, type IResourceEditorInput } from '../editor.js';

import { EditorInputSerializers, requireRecord, requireSerializedEditorInput } from "../../services/editor/common/editorInputSerializer.js";
import { SideBySideEditorInput } from './sideBySideEditorInput.js';

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
			...(input.preferredName === undefined ? {} : { label: input.preferredName }),
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
export class DiffEditorInput extends SideBySideEditorInput implements IResourceDiffEditorInput {
	public readonly typeId = 'workbench.editorInput.diff';
	public readonly contentType = DIFF_EDITOR_CONTENT_TYPE;
	public get original(): IResourceEditorInput { return this.secondary; }
	public get modified(): IResourceEditorInput { return this.primary; }
}

/** Creates a stable synthetic tab identity for an original/modified comparison. */
export function createDiffEditorInput(original: IResourceEditorInput, modified: IResourceEditorInput, label?: string): DiffEditorInput {
	assertTextResourceInput(original, "Diff original input");
	assertTextResourceInput(modified, "Diff modified input");
	if (label !== undefined && (typeof label !== "string" || label.trim().length === 0)) {
		throw new TypeError("Diff editor label must be a non-empty string");
	}
	const resource = URI.parse(`ash-diff:/compare?original=${encodeURIComponent(original.resource.toString())}&modified=${encodeURIComponent(modified.resource.toString())}`);
	return new DiffEditorInput(resource, original, modified, label?.trim());
}

/** Narrows a generic Workbench editor input to the two-resource diff contract. */
export function isDiffEditorInput(input: IResourceEditorInput): input is DiffEditorInput {
	return input instanceof DiffEditorInput && input.contentType === DIFF_EDITOR_CONTENT_TYPE &&
		isResourceDiffEditorInput(input);
}

function assertTextResourceInput(value: unknown, owner: string): asserts value is IResourceEditorInput {
	if (!isTextResourceInput(value)) throw new TypeError(`${owner} requires an editor resource`);
}

function isTextResourceInput(value: unknown): value is IResourceEditorInput {
	return typeof value === "object" && value !== null &&
		"resource" in value &&
		typeof (value as IResourceEditorInput).resource?.toString === "function";
}

export const BINARY_DIFF_EDITOR_CONTENT_TYPE = "application/vnd.ash.binary-diff";

export class BinaryDiffEditorInput extends SideBySideEditorInput implements IResourceDiffEditorInput {
	public readonly typeId = 'workbench.editorInput.binaryDiff';
	public readonly contentType = BINARY_DIFF_EDITOR_CONTENT_TYPE;
	public get original(): IResourceEditorInput { return this.secondary; }
	public get modified(): IResourceEditorInput { return this.primary; }
}

/** Compares two file resources without decoding their contents as text. */
export function createBinaryDiffEditorInput(original: IResourceEditorInput, modified: IResourceEditorInput, label?: string): BinaryDiffEditorInput {
	if (!canReadBinary(original) || !canReadBinary(modified)) {
		throw new TypeError("Binary comparison requires two file resources");
	}
	const resource = URI.parse(`ash-binary-diff:/compare?original=${encodeURIComponent(original.resource.toString())}&modified=${encodeURIComponent(modified.resource.toString())}`);
	return new BinaryDiffEditorInput(resource, original, modified, label);
}

export function isBinaryDiffEditorInput(input: IResourceEditorInput): input is BinaryDiffEditorInput {
	return input instanceof BinaryDiffEditorInput && input.contentType === BINARY_DIFF_EDITOR_CONTENT_TYPE &&
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
			...(input.preferredName === undefined ? {} : { label: input.preferredName }),
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

function canReadBinary(value: unknown): value is IResourceEditorInput {
	if (typeof value !== "object" || value === null || !("resource" in value)) return false;
	const resource = (value as IResourceEditorInput).resource;
	return resource instanceof URI && (resource.scheme === Schemas.file || isRemoteResource(resource));
}
