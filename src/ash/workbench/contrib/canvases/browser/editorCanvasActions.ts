import { Action2, MenuId, MenusRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IInstantiationService, type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { localize, localize2 } from '../../../../nls.js';
import {
	ICanvasContextService, ICanvasService, CanvasInput, canvasOwnerKey,
	getCanvasDefinitionInstanceId, getCanvasDefinitionLabels, getCanvasInstanceLabels, isCanvasOwner,
} from '../common/canvas.js';
import { DisposableStore, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { showCanvasContextPicker } from './canvasContextPicker.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { autorun, derived, observableSignalFromEvent, type IReader } from '../../../../base/common/observable.js';
import { Event } from '../../../../base/common/event.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IChatSessionNavigationService } from '../../../services/chat/common/chatSessionNavigationService.js';
import { IChatWidgetService } from '../../chat/browser/chat.js';
import { ChatContextKeys } from '../../chat/common/actions/chatContextKeys.js';
import { CanvasDefinitionStore } from '../common/canvasDefinitionStore.js';

export const OPEN_EDITOR_CANVAS_COMMAND_ID = 'workbench.action.chat.openCanvas';
const CanvasOwnerAvailableContext = new RawContextKey<boolean>('canvasOwnerAvailable', false);
const ChatNewCanvasMenuId = new MenuId('ChatNewCanvasMenu');

registerAction2(class OpenCanvasAction extends Action2 {
	constructor() {
		super({
			id: OPEN_EDITOR_CANVAS_COMMAND_ID, title: localize2('canvas.open', 'Open Canvas…'), icon: Lxicon.preview, f1: true,
			precondition: ContextKeyExpr.has(CanvasOwnerAvailableContext.key),
		});
	}
	run(accessor: ServicesAccessor): Promise<void> { return showCanvasContextPicker(accessor); }
});

/** Projects only the selected conversation's available canvases into New Chat. */
export function registerEditorCanvasActions(accessor: ServicesAccessor): IDisposable {
	const resources = new DisposableStore();
	const canvases = accessor.get(ICanvasService);
	const contexts = accessor.get(ICanvasContextService);
	const navigation = accessor.get(IChatSessionNavigationService);
	const widgets = accessor.get(IChatWidgetService);
	const notifications = accessor.get(INotificationService);
	const ownerAvailable = CanvasOwnerAvailableContext.bindTo(accessor.get(IContextKeyService));
	const changed = observableSignalFromEvent(resources, Event.any(contexts.onDidChangeVisibility, widgets.onDidChangeWidgets));
	const current = derived(reader => {
		changed.read(reader);
		const selected = navigation.getActiveConversation();
		return canvases.enabled.read(reader) && selected ? contexts.contexts.read(reader).find(context =>
			context.owner.session.path.slice(1) === selected.sessionId && context.owner.chat.path.slice(1) === selected.threadId && contexts.isOwnerVisible(context.owner, reader)) : undefined;
	});
	const definitions = resources.add(accessor.get(IInstantiationService).createInstance(CanvasDefinitionStore, (reader: IReader) => {
		const context = current.read(reader);
		if (!context?.definitionProvider) return undefined;
		observableSignalFromEvent(context, context.definitionProvider.onDidChangeDefinitions).read(reader);
		return { owner: context.owner, listCanvases: () => context.definitionProvider!.listCanvases() };
	}, 'Canvas New Chat menu'));
	resources.add(autorun(reader => ownerAvailable.set(current.read(reader) !== undefined)));
	resources.add(toDisposable(() => ownerAvailable.reset()));
	resources.add(MenusRegistry.appendMenuItem(MenuId.ChatNewMenu, {
		submenu: ChatNewCanvasMenuId, title: localize('canvas.menu', 'Canvas'), group: 'z_canvas', when: ChatContextKeys.enabled.isEqualTo(true),
	}));
	const commands = resources.add(CommandsRegistry.registerMany([]));
	const menuItems = resources.add(new DisposableStore());
	let rendered = '';
	resources.add(autorun(reader => {
		const context = current.read(reader);
		if (!context) {
			commands.replace([]);
			menuItems.clear();
			rendered = '';
			return;
		}
		const ownerKey = encodeURIComponent(canvasOwnerKey(context.owner));
		const registered = definitions.definitions.read(reader);
		const reopenable = canvases.reopenableCanvases.read(reader).filter(target => isCanvasOwner(target.reference, context.owner)
			&& !registered.some(definition => getCanvasDefinitionInstanceId(definition) === target.canvas.instanceId));
		const names = getCanvasDefinitionLabels(registered);
		const titles = getCanvasInstanceLabels(reopenable.map(target => target.canvas));
		const choices = [
			...registered.map((definition, index) => ({
				id: `${OPEN_EDITOR_CANVAS_COMMAND_ID}.${ownerKey}.${getCanvasDefinitionInstanceId(definition)}`,
				label: names[index]!, group: '1_available',
				run: async () => {
					if (!definitions.definitions.get().some(candidate => candidate.extensionId === definition.extensionId && candidate.canvasId === definition.canvasId)) return;
					await context.definitionProvider!.openCanvas(definition, getCanvasDefinitionInstanceId(definition));
				},
			})),
			...reopenable.map((target, index) => ({
				id: `${REOPEN_EDITOR_CANVAS_COMMAND_ID}.${ownerKey}.${encodeURIComponent(target.reference.canvas.toString())}`,
				label: titles[index]!, group: '2_open',
				run: async () => {
					if (canvases.isOwnerPresentable(target.reference)) await canvases.reopenCanvas(target.reference);
				},
			})),
		];
		// Preserve command identities and menu triggers while the same choices refresh.
		commands.replace(choices.map(choice => ({
			id: choice.id,
			handler: async () => {
				const selected = current.get();
				// A menu opened before switching chats must never act on the next chat.
				if (!selected || !isCanvasOwner(selected.owner, context.owner)) return;
				try { await choice.run(); }
				catch (error) { notifications.error(localize('canvas.menuOpenFailed', 'Could not open Canvas {0}: {1}', choice.label, String(error))); }
			},
		})));
		const next = JSON.stringify(choices.map(({ id, label, group }) => ({ id, label, group })));
		if (next === rendered) return;
		rendered = next;
		menuItems.clear();
		for (const [order, choice] of choices.entries()) {
			menuItems.add(MenusRegistry.appendMenuItem(ChatNewCanvasMenuId, {
				command: { id: choice.id, title: choice.label, icon: Lxicon.preview, precondition: ChatContextKeys.enabled.isEqualTo(true) },
				when: ChatContextKeys.enabled.isEqualTo(true), group: choice.group, order,
			}));
		}
	}));
	return resources;
}

export const REOPEN_EDITOR_CANVAS_COMMAND_ID = 'workbench.action.chat.reopenCanvas';
export const CanvasAvailableContext = new RawContextKey<boolean>('canvasesAvailable', false);

registerAction2(class ReopenCanvasAction extends Action2 {
	constructor() {
		super({
			id: REOPEN_EDITOR_CANVAS_COMMAND_ID, title: localize2('canvas.open', 'Open Canvas…'), f1: true,
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
});

registerAction2(class CloseCanvasAction extends Action2 {
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
});
