import { DisposableStore, type IDisposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { isRecord } from '../../../../base/common/types.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize2 } from '../../../../nls.js';
import { Action2, MenuId, MenusRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ISessionsProvidersService } from '../../../services/sessions/browser/sessionsProvidersService.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { CanvasInput, type ICanvasReference } from '../../../../workbench/contrib/canvases/common/canvas.js';
import { ActivityBarItemContext } from '../../../common/contextkeys.js';
import { Menus } from '../../../browser/menus.js';
import { IPinnedCanvasService, type PinnedCanvasTarget } from '../browser/pinnedCanvases.js';

export const ADD_CANVAS_TO_SIDEBAR_COMMAND_ID = 'workbench.action.agentSessions.addCanvasToSidebar';
export const REMOVE_CANVAS_FROM_SIDEBAR_COMMAND_ID = 'workbench.action.agentSessions.removeCanvasFromSidebar';
export const GO_TO_PINNED_CANVAS_CHAT_COMMAND_ID = 'workbench.action.agentSessions.goToPinnedCanvasChat';
export const CLOSE_PINNED_CANVAS_COMMAND_ID = 'workbench.action.agentSessions.closePinnedCanvas';

function target(accessor: ServicesAccessor, value: unknown): PinnedCanvasTarget | undefined {
	if (value instanceof CanvasInput) { return value.reference; }
	if (isRecord(value) && typeof value.providerId === 'string' && URI.isUri(value.session) && URI.isUri(value.chat) && URI.isUri(value.canvas)) {
		return value as unknown as ICanvasReference;
	}
	const selected = accessor.get(IPinnedCanvasService).selected.get();
	const input = accessor.get(IEditorService).activeEditor;
	return selected ?? (input instanceof CanvasInput ? input.reference : undefined);
}

registerAction2(class AddCanvasToSidebarAction extends Action2 {
	constructor() {
		super({
			id: ADD_CANVAS_TO_SIDEBAR_COMMAND_ID, title: localize2('pinnedCanvas.add', 'Add Canvas to Sidebar'), icon: Lxicon.pin, f1: true,
			precondition: ContextKeyExpr.equals('activeEditor', CanvasInput.EDITOR_ID),
			menu: { id: MenuId.EditorTitleContext, group: 'canvas', when: ContextKeyExpr.equals('activeEditor', CanvasInput.EDITOR_ID) }
		});
	}
	run(accessor: ServicesAccessor, value?: unknown): void {
		const candidate = target(accessor, value);
		if (candidate && !('identity' in candidate)) { accessor.get(IPinnedCanvasService).pin(candidate); }
	}
});

const RECONNECT_PINNED_CANVAS_COMMAND_ID = 'workbench.action.agentSessions.reconnectPinnedCanvas';

const headerActions = [
	{ id: RECONNECT_PINNED_CANVAS_COMMAND_ID, title: localize2('pinnedCanvas.reconnect', 'Reconnect Canvas'), icon: Lxicon.refresh, run: (pins: IPinnedCanvasService, pin: PinnedCanvasTarget) => pins.reconnect(pin) },
	{ id: GO_TO_PINNED_CANVAS_CHAT_COMMAND_ID, title: localize2('pinnedCanvas.goToChat', 'Go to Chat'), icon: Lxicon.chat, run: (pins: IPinnedCanvasService, pin: PinnedCanvasTarget) => pins.goToChat(pin) },
	{ id: REMOVE_CANVAS_FROM_SIDEBAR_COMMAND_ID, title: localize2('pinnedCanvas.remove', 'Remove from Sidebar'), icon: Lxicon.unpin, run: (pins: IPinnedCanvasService, pin: PinnedCanvasTarget) => pins.unpin(pin) },
	{ id: CLOSE_PINNED_CANVAS_COMMAND_ID, title: localize2('canvas.close', 'Close Canvas'), icon: Lxicon.close, run: (pins: IPinnedCanvasService, pin: PinnedCanvasTarget) => pins.closeCanvas(pin) },
] as const;

for (const action of headerActions) {
	registerAction2(class extends Action2 {
		constructor() { super({ id: action.id, title: action.title, icon: action.icon, menu: action.id === REMOVE_CANVAS_FROM_SIDEBAR_COMMAND_ID ? [{ id: Menus.CustomViewCanvas, group: 'navigation' }, { id: MenuId.EditorTitleContext, group: 'canvas', when: ContextKeyExpr.equals('activeEditor', CanvasInput.EDITOR_ID) }] : { id: Menus.CustomViewCanvas, group: 'navigation' } }); }
		run(accessor: ServicesAccessor, value?: unknown): void | Promise<void> {
			const candidate = target(accessor, value);
			if (candidate) { return runPinnedAction(accessor, action, candidate); }
		}
	});
}

function runPinnedAction(accessor: ServicesAccessor, action: typeof headerActions[number], target: PinnedCanvasTarget): void | Promise<void> {
	const pins = accessor.get(IPinnedCanvasService);
	const entry = pins.getEntry(target);
	if (action.id === RECONNECT_PINNED_CANVAS_COMMAND_ID && entry && entry.identity.providerId !== 'local-agent-host'
		&& !accessor.get(ISessionsProvidersService).getProvider(entry.identity.providerId)) {
		// An explicitly disconnected host has no borrowed runtime to reconnect. Let its owner reacquire it.
		return accessor.get(ICommandService).executeCommand('sessions.action.manageAgentHosts');
	}
	return action.run(pins, target);
}

/** Sidebar commands borrow pins; they never retain a browser model or another selection. */
export function registerPinnedCanvasSidebar(pins: IPinnedCanvasService, notifications: INotificationService): IDisposable {
	const lifetime = new DisposableStore();
	const items = lifetime.add(new DisposableStore());
	lifetime.add(autorun(reader => {
		const entries = pins.entries.read(reader);
		const selected = pins.selected.read(reader);
		const labels = entries.map(pin => pin.title.read(reader));
		items.clear();
		for (const [index, pin] of entries.entries()) {
			const id = 'sessions.pinnedCanvas.' + pin.id;
			const invoke = (operation: (accessor: ServicesAccessor) => Promise<void> | void) => async (accessor: ServicesAccessor) => {
				try { await operation(accessor); } catch (error) { notifications.error(String(error)); }
			};
			items.add(CommandsRegistry.register(id, invoke(() => pins.show(pin))));
			for (const menuId of [Menus.ActivityBar, Menus.CodeActivityBar]) {
				items.add(MenusRegistry.appendMenuItem(menuId, { command: { id, title: labels[index]!, icon: Lxicon.preview, toggled: selected === pin ? ContextKeyExpr.true() : ContextKeyExpr.false() }, group: 'navigation', order: 50 + index }));
			}
			for (const action of headerActions) {
				const command = id + '.' + action.id.slice(action.id.lastIndexOf('.') + 1);
				items.add(CommandsRegistry.register(command, invoke(accessor => runPinnedAction(accessor, action, pin))));
				items.add(MenusRegistry.appendMenuItem(Menus.ActivityBarContext, {
					command: { id: command, title: action.title, icon: action.icon }, group: 'canvas', when: ActivityBarItemContext.isEqualTo(id),
				}));
			}
		}
	}));
	return lifetime;
}
