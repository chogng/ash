import { URI } from '../../../../base/common/uri.js';
import { DisposableStore, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize, localize2 } from '../../../../nls.js';
import type { ICanvasReference } from '../../../common/canvasReference.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import {
	CanvasInput, ICanvasContextService, ICanvasService, OPEN_CANVAS_COMMAND_ID, REOPEN_CANVAS_COMMAND_ID, REVEAL_CANVAS_COMMAND_ID,
} from '../common/canvas.js';
import { showCanvasContextPicker } from '../browser/canvasContextPicker.js';

const CanvasOwnerAvailableContext = new RawContextKey<boolean>('canvasOwnerAvailable', false);
const CanvasAvailableContext = new RawContextKey<boolean>('canvasesAvailable', false);

/** Commands shared by both desktop hosts. Menu placement belongs to each host. */
export function registerCanvasCommands(accessor: ServicesAccessor): IDisposable {
	const resources = new DisposableStore();
	const canvases = accessor.get(ICanvasService);
	const contexts = accessor.get(ICanvasContextService);
	const keys = accessor.get(IContextKeyService);
	const ownerAvailable = CanvasOwnerAvailableContext.bindTo(keys);
	const available = CanvasAvailableContext.bindTo(keys);
	resources.add(autorun(reader => ownerAvailable.set(canvases.enabled.read(reader) && contexts.getActiveContext(reader) !== undefined)));
	resources.add(autorun(reader => available.set(canvases.reopenableCanvases.read(reader).length > 0)));
	resources.add(toDisposable(() => { ownerAvailable.reset(); available.reset(); }));

	resources.add(CommandsRegistry.register(REVEAL_CANVAS_COMMAND_ID, (accessor, value: unknown) => {
		const reference = value as Partial<ICanvasReference> | undefined;
		if (!reference || typeof reference.providerId !== 'string' || !URI.isUri(reference.session) || !URI.isUri(reference.chat) || !URI.isUri(reference.canvas)) {
			throw new TypeError('Invalid Canvas reference');
		}
		return accessor.get(ICanvasService).revealCanvas(reference as ICanvasReference);
	}));

	resources.add(registerAction2(class OpenCanvasAction extends Action2 {
		constructor() {
			super({
				id: OPEN_CANVAS_COMMAND_ID, title: localize2('canvas.open', 'Open Canvas…'), icon: Lxicon.preview, f1: true,
				precondition: ContextKeyExpr.has(CanvasOwnerAvailableContext.key),
			});
		}
		run(accessor: ServicesAccessor): Promise<void> { return showCanvasContextPicker(accessor); }
	}));

	resources.add(registerAction2(class ReopenCanvasAction extends Action2 {
		constructor() {
			super({
				id: REOPEN_CANVAS_COMMAND_ID, title: localize2('canvas.open', 'Open Canvas…'), f1: true,
				precondition: ContextKeyExpr.has(CanvasAvailableContext.key),
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			const canvases = accessor.get(ICanvasService);
			const items = canvases.reopenableCanvases.get().map(target => ({
				label: target.canvas.title, description: target.canvas.instanceId, target,
			}));
			using resources = new DisposableStore();
			const picker = resources.add(accessor.get(IQuickInputService).createQuickPick<typeof items[number]>());
			picker.items = items;
			picker.placeholder = picker.ariaLabel = localize('canvas.pick', 'Open a Canvas from a visible conversation');
			resources.add(canvases.reopenableCanvases.onDidChange(() => {
				picker.items = canvases.reopenableCanvases.get().map(target => ({
					label: target.canvas.title,
					description: target.canvas.instanceId,
					target
				}));
			}));
			const selected = await new Promise<typeof items[number] | undefined>(resolve => {
				resources.add(picker.onDidAccept(() => { resolve(picker.selectedItems[0] ?? picker.activeItems[0]); picker.hide(); }));
				resources.add(picker.onDidHide(() => resolve(undefined)));
				picker.show();
			});
			if (selected && canvases.isOwnerPresentable(selected.target.reference)) { await canvases.reopenCanvas(selected.target.reference); }
		}
	}));

	resources.add(registerAction2(class CloseCanvasAction extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.chat.closeCanvas', title: localize2('canvas.close', 'Close Canvas'), f1: true,
				precondition: ContextKeyExpr.equals('activeEditor', CanvasInput.EDITOR_ID),
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			const input = accessor.get(IEditorService).activeEditor;
			if (input instanceof CanvasInput) { await accessor.get(ICanvasService).closeCanvas(input.reference); }
		}
	}));
	return resources;
}
