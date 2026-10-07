import type { IResourceEditorInput } from '../../../common/editor.js';
import { EditorInputSerializers, requireRecord, requireString, type EditorInputSerializer, type EditorInputSerializerRegistry, type SerializedEditorInput } from '../../../services/editor/common/editorInputSerializer.js';
import { CustomEditorInput } from './customEditorInput.js';

export class CustomEditorInputSerializer implements EditorInputSerializer {
	public readonly typeId = CustomEditorInput.ID;
	public canSerialize(input: IResourceEditorInput): boolean { return input instanceof CustomEditorInput; }
	public serialize(input: IResourceEditorInput, registry: EditorInputSerializerRegistry): unknown {
		if (!(input instanceof CustomEditorInput)) {
			throw new TypeError('Expected a custom editor input');
		}
		return { editorId: input.editorId, source: registry.serialize(input.toUntyped()) };
	}
	public deserialize(value: unknown, registry: EditorInputSerializerRegistry): CustomEditorInput {
		const input = requireRecord(value, 'custom editor input');
		return new CustomEditorInput(registry.deserialize(input.source as SerializedEditorInput), requireString(input.editorId, 'custom editor ID'));
	}
}

EditorInputSerializers.registerStatic(new CustomEditorInputSerializer());
