import { DisposableMap, DisposableStore, MutableDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { MenusRegistry } from '../../../../platform/actions/common/actions.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { getCanvasDefinitionInstanceId, getCanvasDefinitionLabels, getCanvasInstanceLabels, getCanvasReferenceKey, type ICanvasService, type ICanvasContextService } from '../../../../workbench/contrib/canvases/common/canvas.js';
import { showCanvasContextPicker } from '../../../../workbench/contrib/canvases/browser/canvasContextPicker.js';
import type { ISessionCanvasRegistryService } from '../common/sessionCanvas.js';
import { Menus } from '../../../browser/menus.js';
import { StringSHA1 } from '../../../../base/common/hash.js';

export const OPEN_SESSION_CANVAS_COMMAND_ID = 'workbench.action.agentSessions.openCanvas';
export const REOPEN_SESSION_CANVAS_COMMAND_ID = 'workbench.action.agentSessions.reopenCanvas';

export function registerSessionCanvasActions(canvases: ICanvasService, registry: ISessionCanvasRegistryService, contexts: ICanvasContextService): IDisposable {
	const lifetime = new DisposableStore();
	const menu = lifetime.add(new DisposableStore());
	const activity = lifetime.add(new MutableDisposable());
	const commands = lifetime.add(new DisposableMap<string, IDisposable>());
	let menuIdentity = '';
	lifetime.add(CommandsRegistry.register(OPEN_SESSION_CANVAS_COMMAND_ID, accessor => {
		const live = contexts.contexts.get().filter(context => contexts.isOwnerVisible(context.owner)).flatMap(context => context.canvases.get()?.filter(canvas => canvas.source).map(canvas => ({ reference: { ...context.owner, canvas: canvas.resource }, canvas })) ?? []);
		return live.length === 1 ? canvases.revealCanvas(live[0]!.reference) : showCanvasContextPicker(accessor);
	}));
	lifetime.add(CommandsRegistry.register(REOPEN_SESSION_CANVAS_COMMAND_ID, accessor => showCanvasContextPicker(accessor)));
	lifetime.add(autorun(reader => {
		const enabled = canvases.enabled.read(reader);
		const definitions = enabled ? registry.availableCanvases.read(reader) : [];
		const live = enabled ? canvases.reopenableCanvases.read(reader) : [];
		const identity = JSON.stringify([definitions, live.map(target => [getCanvasReferenceKey(target.reference), target.canvas.title, target.canvas.instanceId])]);
		if (identity === menuIdentity) { return; }
		menuIdentity = identity;
		menu.clear();
		const active = new Set<string>();
		const labels = getCanvasDefinitionLabels(definitions);
		for (const [index, definition] of definitions.entries()) {
			const id = OPEN_SESSION_CANVAS_COMMAND_ID + '.' + getCanvasDefinitionInstanceId(definition);
			active.add(id);
			if (!commands.has(id)) {
				commands.set(id, CommandsRegistry.register(id, () => registry.openCanvas(definition)));
			}
			menu.add(MenusRegistry.appendMenuItem(Menus.SessionsEditorTabsBarAddTabCanvas, { command: { id, title: labels[index]! }, group: 'new', order: index }));
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
			menu.add(MenusRegistry.appendMenuItem(Menus.CodeAddTab, { submenu: Menus.SessionsEditorTabsBarAddTabCanvas, title: localize2('canvas.editorName', 'Canvas'), group: 'navigation', order: 20 }));
			if (!activity.value) { activity.value = MenusRegistry.appendMenuItem(Menus.ActivityBar, { command: { id: OPEN_SESSION_CANVAS_COMMAND_ID, title: localize2('canvas.editorName', 'Canvas'), icon: Lxicon.preview }, group: 'navigation', order: 40 }); }
		} else { activity.clear(); }
		for (const id of commands.keys()) { if (!active.has(id)) { commands.deleteAndDispose(id); } }
	}));
	return lifetime;
}
