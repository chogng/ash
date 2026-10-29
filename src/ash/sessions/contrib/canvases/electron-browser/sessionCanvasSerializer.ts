import { CanvasInput, ICanvasService } from '../../../../workbench/contrib/canvases/common/canvas.js';
import type { IResourceEditorInput } from '../../../../workbench/common/editor.js';
import { UnknownEditorInputSerializerError, type EditorInputSerializer } from '../../../../workbench/services/editor/common/editorInputSerializer.js';

/** Persistence contains only a versioned nonce admitted by this live renderer. It never grants URL reconstruction. */
export class SessionCanvasSerializer implements EditorInputSerializer {
	readonly typeId = CanvasInput.ID;
	constructor(@ICanvasService private readonly canvases: ICanvasService) {}
	canSerialize(input: IResourceEditorInput): boolean {
		return input instanceof CanvasInput;
	}
	serialize(input: IResourceEditorInput): { version: 1; id: string } | null {
		return input instanceof CanvasInput && this.canvases.restoreCanvasInput(input.serializationId) === input ? { version: 1, id: input.serializationId } : null;
	}
	deserialize(value: unknown): CanvasInput {
		if (typeof value !== 'object' || value === null || Array.isArray(value)) {
			throw new UnknownEditorInputSerializerError(this.typeId);
		}
		const data = value as Record<string, unknown>;
		if (
			Object.keys(data).sort().join(',') !== 'id,version' ||
			data.version !== 1 ||
			typeof data.id !== 'string' ||
			!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(data.id)
		) {
			throw new UnknownEditorInputSerializerError(this.typeId);
		}
		const input = this.canvases.restoreCanvasInput(data.id);
		if (!input) {
			throw new UnknownEditorInputSerializerError(this.typeId);
		}
		return input;
	}
}
