import { DisposableMap, DisposableStore, MutableDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { Action2, MenusRegistry } from '../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { canvasOwnerKey, getCanvasReferenceKey, isCanvasOwner } from '../../../../workbench/common/canvasReference.js';
import {
	getCanvasDefinitionInstanceId, getCanvasDefinitionLabels, getCanvasInstanceLabels, getPresentableCanvasTargets, ICanvasService, type ICanvasContextService, type ICanvasDefinition,
} from '../../../../workbench/contrib/canvases/common/canvas.js';
import { showCanvasContextPicker } from '../../../../workbench/contrib/canvases/browser/canvasContextPicker.js';
import type { ISessionCanvasRegistryService } from '../common/sessionCanvas.js';
import { Menus } from '../../../browser/menus.js';
import { StringSHA1 } from '../../../../base/common/hash.js';
import { DeferredPromise, disposableTimeout } from '../../../../base/common/async.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { URI } from '../../../../base/common/uri.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IAgentHostCanvasCollection } from '../../../../workbench/contrib/canvases/common/agentHostCanvas.js';
import { IChatSessionNavigationService } from '../../../../workbench/services/chat/common/chatSessionNavigationService.js';
import { IPinnedCanvasService } from '../browser/pinnedCanvases.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import type { ICanvas } from '../../../../workbench/common/canvasReference.js';

export const OPEN_SESSION_CANVAS_COMMAND_ID = 'workbench.action.agentSessions.openCanvas';
export const REOPEN_SESSION_CANVAS_COMMAND_ID = 'workbench.action.agentSessions.reopenCanvas';

export class NewCanvasSessionAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.agentSessions.newCanvasSession',
			title: localize2('canvas.newSession', 'New Canvas Session…'),
			f1: true,
			menu: { id: Menus.SessionsViewFilter, group: 'new' },
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const sessions = accessor.get(ISessionsManagementService);
		const canvasHosts = accessor.get(IAgentHostCanvasCollection);
		const canvases = accessor.get(ICanvasService);
		const pins = accessor.get(IPinnedCanvasService);
		const picker = accessor.get(IQuickInputService);
		const navigation = accessor.get(IChatSessionNavigationService);
		const notifications = accessor.get(INotificationService);
		if (!canvases.enabled.get()) return;
		type CanvasPick = { label: string; description?: string; providerId: string; definition: ICanvasDefinition; };
		let selected: CanvasPick | undefined;
		{
			using pickerResources = new DisposableStore();
			const quickPick = pickerResources.add(picker.createQuickPick<CanvasPick>());
			quickPick.placeholder = quickPick.ariaLabel = localize('canvas.newSession.pick', 'Choose a Canvas to start the session');
			quickPick.busy = true;
			const selection = new DeferredPromise<CanvasPick | undefined>();
			pickerResources.add(quickPick.onDidAccept(() => {
				const item = quickPick.selectedItems[0] ?? quickPick.activeItems[0];
				if (!item) return;
				void selection.complete(item);
				quickPick.hide();
			}));
			pickerResources.add(quickPick.onDidHide(() => void selection.complete(undefined)));
			quickPick.show();
			const loadCatalog = async (): Promise<void> => {
				const { providerId } = await sessions.resolveNewSessionTarget();
				if (selection.isSettled) return;
				const definitions = (await canvasHosts.listProviderCanvases(providerId))?.filter(definition => !definition.requiresInput);
				if (selection.isSettled) return;
				if (!definitions?.length) {
					notifications.info(localize('canvas.newSession.unavailable', 'No Canvas is available to start a session.'));
					quickPick.hide();
					return;
				}
				const labels = getCanvasDefinitionLabels(definitions);
				quickPick.items = definitions.map((definition, index) => ({ label: labels[index]!, description: definition.description, providerId, definition }));
				quickPick.busy = false;
			};
			void loadCatalog().catch(error => selection.error(error));
			selected = await selection.p;
		}
		if (!selected || !canvases.enabled.get()) return;
		const { providerId } = selected;
		const revision = navigation.revision;
		const { session, threadId } = await sessions.startNewSession(selected.definition.displayName, {
			providerId, workspace: { type: 'current' }, creation: { token: CancellationToken.None, kind: 'code' },
		});
		const owner = {
			providerId: session.providerId ?? providerId,
			session: URI.from({ scheme: 'ash-session', path: '/' + session.sessionId }),
			chat: URI.from({ scheme: 'ash-thread', path: '/' + threadId }),
		};
		const context = canvasHosts.createContext(owner);
		const instanceId = getCanvasDefinitionInstanceId(selected.definition);
		try {
			await context.definitionProvider!.openCanvas(selected.definition, instanceId);
			using resources = new DisposableStore();
			const canvas = await new Promise<ICanvas>((resolve, reject) => {
				resources.add(disposableTimeout(() => reject(new Error(localize('canvas.newSession.timeout', 'The Canvas did not open in time.'))), 15_000));
				resources.add(autorun(reader => {
					const opened = context.canvases.read(reader)?.find(candidate => candidate.instanceId === instanceId
						&& candidate.extensionId === selected.definition.extensionId && candidate.canvasId === selected.definition.canvasId);
					if (opened) resolve(opened);
				}));
			});
			const reference = { ...owner, canvas: canvas.resource };
			const pinned = pins.pin(reference);
			if (navigation.revision !== revision) return;
			if (pinned) await pins.show(reference);
			else {
				await navigation.openConversation(session.sessionId, threadId);
				await canvases.revealCanvas(reference);
			}
		} catch (error) {
			if (navigation.revision === revision) await navigation.openConversation(session.sessionId, threadId);
			throw error;
		}
	}
}

export function registerSessionCanvasActions(canvases: ICanvasService, registry: ISessionCanvasRegistryService, contexts: ICanvasContextService): IDisposable {
	const lifetime = new DisposableStore();
	const menu = lifetime.add(new DisposableStore());
	const activity = lifetime.add(new MutableDisposable());
	const commands = lifetime.add(new DisposableMap<string, IDisposable>());
	let menuIdentity = '';
	// The Sessions selection remains active beneath a pinned page, even when Chat navigation has no active conversation.
	const pickCanvas = (accessor: ServicesAccessor) => showCanvasContextPicker(accessor);
	lifetime.add(CommandsRegistry.register(OPEN_SESSION_CANVAS_COMMAND_ID, accessor => {
		const live = contexts.contexts.get().filter(context => contexts.isOwnerVisible(context.owner))
			.flatMap(context => getPresentableCanvasTargets(canvases, context.owner, context.canvases.get() ?? []));
		return live.length === 1 ? canvases.revealCanvas(live[0]!.reference) : pickCanvas(accessor);
	}));
	lifetime.add(CommandsRegistry.register(REOPEN_SESSION_CANVAS_COMMAND_ID, pickCanvas));
	lifetime.add(autorun(reader => {
		const enabled = canvases.enabled.read(reader);
		const owner = enabled ? contexts.getActiveContext(reader)?.owner : undefined;
		const ownerKey = owner && canvasOwnerKey(owner);
		const definitions = owner ? registry.availableCanvases.read(reader) : [];
		const live = enabled ? canvases.reopenableCanvases.read(reader) : [];
		const identity = JSON.stringify([ownerKey, definitions, live.map(target => [getCanvasReferenceKey(target.reference), target.canvas.title, target.canvas.instanceId])]);
		if (identity === menuIdentity) { return; }
		menuIdentity = identity;
		menu.clear();
		const active = new Set<string>();
		if (owner && ownerKey) {
			const digest = new StringSHA1();
			digest.update(ownerKey);
			const prefix = OPEN_SESSION_CANVAS_COMMAND_ID + '.' + digest.digest();
			const labels = getCanvasDefinitionLabels(definitions);
			for (const [index, definition] of definitions.entries()) {
				const id = prefix + '.' + getCanvasDefinitionInstanceId(definition);
				active.add(id);
				if (!commands.has(id)) {
					commands.set(id, CommandsRegistry.register(id, () => {
						const current = contexts.getActiveContext()?.owner;
						if (current && isCanvasOwner(current, owner)) return registry.openCanvas(owner, definition);
					}));
				}
				menu.add(MenusRegistry.appendMenuItem(Menus.SessionsEditorTabsBarAddTabCanvas, { command: { id, title: labels[index]! }, group: 'new', order: index }));
			}
		}
		const liveLabels = getCanvasInstanceLabels(live.map(target => target.canvas));
		for (const [index, target] of live.entries()) {
			const reference = target.reference;
			const digest = new StringSHA1();
			digest.update(getCanvasReferenceKey(target.reference));
			const id = REOPEN_SESSION_CANVAS_COMMAND_ID + '.' + digest.digest();
			active.add(id);
			if (!commands.has(id)) {
				commands.set(id, CommandsRegistry.register(id, () => canvases.isOwnerPresentable(reference) ? canvases.revealCanvas(reference) : undefined));
			}
			menu.add(MenusRegistry.appendMenuItem(Menus.SessionsEditorTabsBarAddTabCanvas, { command: { id, title: localize('canvas.reopenNamed', 'Reopen {0}', liveLabels[index]!) }, group: 'live', order: index }));
		}
		if (definitions.length || live.length) {
			menu.add(MenusRegistry.appendMenuItem(Menus.SessionsEditorTabsBarAddTab, { submenu: Menus.SessionsEditorTabsBarAddTabCanvas, title: localize2('canvas.editorName', 'Canvas'), group: 'navigation', order: 20 }));
			if (!activity.value) { activity.value = MenusRegistry.appendMenuItem(Menus.ActivityBar, { command: { id: OPEN_SESSION_CANVAS_COMMAND_ID, title: localize2('canvas.editorName', 'Canvas'), icon: Lxicon.preview }, group: 'navigation', order: 40 }); }
		} else { activity.clear(); }
		for (const id of commands.keys()) { if (!active.has(id)) { commands.deleteAndDispose(id); } }
	}));
	return lifetime;
}
