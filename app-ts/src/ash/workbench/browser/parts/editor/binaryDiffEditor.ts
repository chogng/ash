import { URI } from "../../../../base/common/uri.js";
import type { IFileService } from "../../../../platform/files/common/files.js";
import { isRemoteResource } from "../../../../platform/remote/common/remote.js";
import { EditorInputSerializers, requireRecord, requireSerializedEditorInput } from "../../../services/editor/common/editorInputSerializer.js";
import { BaseBinaryResourceEditor } from "./binaryEditor.js";
import type { EditorInput } from "./editorInput.js";
import { EditorPaneMatch, type IEditorPaneDescriptor } from "./editorPane.js";
import { SideBySideEditor, type SideBySideEditorInput } from "./sideBySideEditor.js";

export const BINARY_DIFF_EDITOR_ID = "ash.editor.binaryDiff";
export const BINARY_DIFF_EDITOR_CONTENT_TYPE = "application/vnd.ash.binary-diff";

export interface BinaryDiffEditorInput extends SideBySideEditorInput {
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
		"original" in input && "modified" in input &&
		canReadBinary(input.original) && canReadBinary(input.modified);
}

/** Keeps each side's file-size metadata visible to comparison commands and status UI. */
export class BinaryResourceDiffEditor extends SideBySideEditor {
	constructor(files: IFileService) {
		super(BINARY_DIFF_EDITOR_ID, new BaseBinaryResourceEditor(files), new BaseBinaryResourceEditor(files));
	}

	override async setInput(input: EditorInput, signal: AbortSignal): Promise<void> {
		if (!isBinaryDiffEditorInput(input)) throw new TypeError("Binary diff editor requires two binary file inputs");
		await super.setInput(input, signal);
	}

	getMetadata(): string | undefined {
		const original = this.getSecondaryEditorPane() as BaseBinaryResourceEditor;
		const modified = this.getPrimaryEditorPane() as BaseBinaryResourceEditor;
		const before = original.getMetadata();
		const after = modified.getMetadata();
		return before && after ? `${before} ↔ ${after}` : undefined;
	}
}

export function binaryDiffEditorDescriptor(): IEditorPaneDescriptor {
	return {
		id: BINARY_DIFF_EDITOR_ID,
		name: "Binary Diff Editor",
		canOpen: input => isBinaryDiffEditorInput(input) ? EditorPaneMatch.Default : EditorPaneMatch.None,
		create: options => {
			if (!options.fileService) throw new Error("Binary diff editor requires the Workbench file service");
			return new BinaryResourceDiffEditor(options.fileService);
		},
	};
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
	return resource instanceof URI && (resource.scheme === "file" || isRemoteResource(resource));
}
