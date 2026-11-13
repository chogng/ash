import './canvases.contribution.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { EditorInputSerializers, UnknownEditorInputSerializerError } from '../../../services/editor/common/editorInputSerializer.js';
import { registerCanvasContextPicker } from '../browser/canvasContextPicker.js';
import { registerEditorCanvasActions } from '../browser/editorCanvasActions.js';
import { CanvasInput, ICanvasContextService, ICanvasService } from '../common/canvas.js';
import { EditorCanvasContextService } from './editorCanvasContextService.js';

registerSingleton(ICanvasContextService, EditorCanvasContextService, InstantiationType.Delayed);

registerWorkbenchContribution('workbench.contrib.editorCanvasActions', WorkbenchPhase.BlockRestore, accessor => {
	const resources = new DisposableStore();
	const canvases = accessor.get(ICanvasService);
	resources.add(registerCanvasContextPicker(accessor));
	resources.add(registerEditorCanvasActions(accessor));
	resources.add(EditorInputSerializers.register({
		typeId: CanvasInput.ID,
		canSerialize: input => input instanceof CanvasInput,
		serialize: input => (input as CanvasInput).serializationId,
		deserialize: value => {
			const input = typeof value === 'string' ? canvases.restoreCanvasInput(value) : undefined;
			if (!input) throw new UnknownEditorInputSerializerError(CanvasInput.ID);
			return input;
		},
	}));
	return resources;
});
