import { URI } from '../../../../../base/common/uri.js';
import {
	EditorInputSerializers,
	optionalString,
	requireRecord,
	requireString,
	type EditorInputSerializer,
} from '../../../../services/editor/common/editorInputSerializer.js';
import { type EditorInput } from '../../../../services/editor/common/editorService.js';
import { FILE_EDITOR_INPUT_ID, FileEditorInput } from './fileEditorInput.js';

/** Persists file-specific editor identity and caller-selected display details. */
export class FileEditorInputSerializer implements EditorInputSerializer {
	readonly typeId = FILE_EDITOR_INPUT_ID;

	canSerialize(input: EditorInput): boolean {
		return input instanceof FileEditorInput;
	}

	serialize(input: EditorInput): unknown {
		if (!(input instanceof FileEditorInput)) throw new TypeError('Expected a file editor input');
		return Object.freeze({
			resource: input.resource.toString(),
			label: input.label,
			...(input.contentType === undefined ? {} : { contentType: input.contentType }),
			...(input.languageId === undefined ? {} : { languageId: input.languageId }),
			...(input.readOnly === undefined ? {} : { readOnly: input.readOnly }),
		});
	}

	deserialize(value: unknown): FileEditorInput {
		const record = requireRecord(value, 'serialized file editor');
		const readOnly = record.readOnly;
		if (readOnly !== undefined && typeof readOnly !== 'boolean') throw new TypeError('Serialized file read-only state must be boolean');
		return new FileEditorInput(URI.parse(requireString(record.resource, 'serialized file resource')), {
			label: optionalString(record.label, 'serialized file label'),
			contentType: optionalString(record.contentType, 'serialized file content type'),
			languageId: optionalString(record.languageId, 'serialized file language ID'),
			readOnly: readOnly as boolean | undefined,
		});
	}
}

EditorInputSerializers.registerStatic(new FileEditorInputSerializer());
