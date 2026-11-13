import { MenuId, MenusRegistry } from '../../../../platform/actions/common/actions.js';
import { IInstantiationService, type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { localize } from '../../../../nls.js';
import { canvasOwnerKey, isCanvasOwner } from '../../../common/canvasReference.js';
import {
	ICanvasContextService, ICanvasService, OPEN_CANVAS_COMMAND_ID, REOPEN_CANVAS_COMMAND_ID,
	getCanvasDefinitionInstanceId, getCanvasDefinitionLabels, getCanvasInstanceLabels,
} from '../common/canvas.js';
import { DisposableStore, type IDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { autorun, derived, observableSignalFromEvent, type IReader } from '../../../../base/common/observable.js';
import { StringSHA1 } from '../../../../base/common/hash.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ChatContextKeys } from '../../chat/common/actions/chatContextKeys.js';
import { CanvasDefinitionStore } from '../common/canvasDefinitionStore.js';

const ChatNewCanvasMenuId = new MenuId('ChatNewCanvasMenu');

/** Projects only the selected conversation's available canvases into New Chat. */
export function registerEditorCanvasActions(accessor: ServicesAccessor): IDisposable {
	const resources = new DisposableStore();
	const canvases = accessor.get(ICanvasService);
	const contexts = accessor.get(ICanvasContextService);
	const notifications = accessor.get(INotificationService);
	const current = derived(reader => canvases.enabled.read(reader) ? contexts.getActiveContext(reader) : undefined);
	const definitions = resources.add(accessor.get(IInstantiationService).createInstance(CanvasDefinitionStore, (reader: IReader) => {
		const context = current.read(reader);
		if (!context?.definitionProvider) return undefined;
		observableSignalFromEvent(context, context.definitionProvider.onDidChangeDefinitions).read(reader);
		return { owner: context.owner, listCanvases: () => context.definitionProvider!.listCanvases() };
	}, 'Canvas New Chat menu'));
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
		const ownerKey = canvasCommandKey(canvasOwnerKey(context.owner));
		const registered = definitions.definitions.read(reader);
		const reopenable = canvases.reopenableCanvases.read(reader).filter(target => isCanvasOwner(target.reference, context.owner)
			&& !registered.some(definition => getCanvasDefinitionInstanceId(definition) === target.canvas.instanceId));
		const names = getCanvasDefinitionLabels(registered);
		const titles = getCanvasInstanceLabels(reopenable.map(target => target.canvas));
		const choices = [
			...registered.map((definition, index) => ({
				id: `${OPEN_CANVAS_COMMAND_ID}.${ownerKey}.${getCanvasDefinitionInstanceId(definition)}`,
				label: names[index]!, group: '1_available',
				run: async () => {
					if (!definitions.definitions.get().some(candidate => candidate.extensionId === definition.extensionId && candidate.canvasId === definition.canvasId)) return;
					await context.definitionProvider!.openCanvas(definition, getCanvasDefinitionInstanceId(definition));
				},
			})),
			...reopenable.map((target, index) => ({
				id: `${REOPEN_CANVAS_COMMAND_ID}.${ownerKey}.${canvasCommandKey(target.reference.canvas.toString())}`,
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

/** Keep dynamic menu commands within the registry's ID limit for long owner and page identities. */
function canvasCommandKey(identity: string): string {
	const hash = new StringSHA1();
	hash.update(identity);
	return hash.digest();
}
