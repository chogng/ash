import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { localize, localize2 } from '../../../../nls.js';
import { ICanvasService, CanvasInput } from '../common/canvas.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { showCanvasContextPicker } from './canvasContextPicker.js';
import { Lxicon } from '../../../../base/common/lxicons.js';

export const OPEN_EDITOR_CANVAS_COMMAND_ID = 'workbench.action.chat.openCanvas';
export const CanvasOwnerAvailableContext = new RawContextKey<boolean>('canvasOwnerAvailable', false);

registerAction2(
	class OpenCanvasAction extends Action2 {
		constructor() {
			super({
				id: OPEN_EDITOR_CANVAS_COMMAND_ID,
				title: localize2('canvas.open', 'Open Canvas…'),
				icon: Lxicon.preview,
				f1: true,
				precondition: ContextKeyExpr.has(CanvasOwnerAvailableContext.key),
				menu: [
					{ id: MenuId.ChatTitle, group: 'navigation', order: 20 },
					{ id: MenuId.ChatInputSecondary, group: 'navigation', order: 20 },
				],
			});
		}
		run(accessor: ServicesAccessor): Promise<void> {
			return showCanvasContextPicker(accessor);
		}
	},
);

export const REOPEN_EDITOR_CANVAS_COMMAND_ID = 'workbench.action.chat.reopenCanvas';
export const CanvasAvailableContext = new RawContextKey<boolean>('canvasesAvailable', false);

registerAction2(
	class ReopenCanvasAction extends Action2 {
		constructor() {
			super({
				id: REOPEN_EDITOR_CANVAS_COMMAND_ID,
				title: localize2('canvas.open', 'Open Canvas…'),
				f1: true,
				precondition: ContextKeyExpr.has(CanvasAvailableContext.key),
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			const canvases = accessor.get(ICanvasService);
			const items = canvases.reopenableCanvases
				.get()
				.map(target => ({ label: target.canvas.title, description: target.canvas.instanceId, target }));
			using resources = new DisposableStore();
			const picker = resources.add(accessor.get(IQuickInputService).createQuickPick<(typeof items)[number]>());
			picker.items = items;
			picker.placeholder = picker.ariaLabel = localize(
				'canvas.pick',
				'Open a Canvas from a visible conversation',
			);
			resources.add(
				canvases.reopenableCanvases.onDidChange(() => {
					picker.items = canvases.reopenableCanvases
						.get()
						.map(target => ({ label: target.canvas.title, description: target.canvas.instanceId, target }));
				}),
			);
			const selected = await new Promise<(typeof items)[number] | undefined>(resolve => {
				resources.add(
					picker.onDidAccept(() => {
						resolve(picker.selectedItems[0] ?? picker.activeItems[0]);
						picker.hide();
					}),
				);
				resources.add(picker.onDidHide(() => resolve(undefined)));
				picker.show();
			});
			if (selected && canvases.isOwnerPresentable(selected.target.reference)) {
				await canvases.reopenCanvas(selected.target.reference);
			}
		}
	},
);

registerAction2(
	class CloseCanvasAction extends Action2 {
		constructor() {
			super({
				id: 'workbench.action.chat.closeCanvas',
				title: localize2('canvas.close', 'Close Canvas'),
				f1: true,
				precondition: ContextKeyExpr.equals('activeEditor', CanvasInput.EDITOR_ID),
			});
		}
		async run(accessor: ServicesAccessor): Promise<void> {
			const input = accessor.get(IEditorService).activeEditor;
			if (input instanceof CanvasInput) {
				await accessor.get(ICanvasService).closeCanvas(input.reference);
			}
		}
	},
);
