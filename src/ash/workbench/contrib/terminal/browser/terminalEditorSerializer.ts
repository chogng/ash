import { URI } from '../../../../base/common/uri.js';
import type { IResourceEditorInput } from '../../../common/editor.js';
import {
	requireRecord,
	requireString,
	type EditorInputSerializer,
} from '../../../services/editor/common/editorInputSerializer.js';
import { TerminalEditorInput } from './terminalEditorInput.js';

/** Persist identity only. A missing live instance is displayed as unavailable, never relaunched. */
export class TerminalInputSerializer implements EditorInputSerializer {
	readonly typeId = TerminalEditorInput.ID;
	canSerialize(input: IResourceEditorInput): boolean {
		return input instanceof TerminalEditorInput;
	}
	serialize(input: IResourceEditorInput): unknown {
		return { resource: input.resource.toString() };
	}
	deserialize(value: unknown): TerminalEditorInput {
		const record = requireRecord(value, 'terminal editor input');
		return new TerminalEditorInput(URI.parse(requireString(record.resource, 'terminal editor resource')));
	}
}
