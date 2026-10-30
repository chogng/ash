import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { autorun, derived, observableSignalFromEvent, type IReader } from '../../../../base/common/observable.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IInstantiationService, type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import {
	ICanvasContextService, ICanvasService, getCanvasDefinitionInstanceId, getCanvasDefinitionLabels,
	getCanvasInstanceLabels, isCanvasOwner, isOpenableExtensionCanvasDefinition, type ICanvasOwner,
} from '../common/canvas.js';
import { CanvasDefinitionStore } from '../common/canvasDefinitionStore.js';
import { IChatSessionNavigationService } from '../../../services/chat/common/chatSessionNavigationService.js';
import { localize } from '../../../../nls.js';
import { IChatContextPickService, type ChatContextPick } from '../../chat/browser/attachments/chatContextPickService.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { Event } from '../../../../base/common/event.js';

/** Add context invokes Canvas actions and returns `noop`, leaving the draft and attachments untouched. */
export function registerCanvasContextPicker(accessor: ServicesAccessor) {
	const contexts = accessor.get(ICanvasContextService);
	const canvases = accessor.get(ICanvasService);
	const navigation = accessor.get(IChatSessionNavigationService);
	const instantiation = accessor.get(IInstantiationService);
	const current = () => {
		const selected = navigation.getActiveConversation();
		return selected && canvases.enabled.get() ? contexts.contexts.get().find(context => contexts.isOwnerVisible(context.owner)
			&& context.owner.session.path.slice(1) === selected.sessionId && context.owner.chat.path.slice(1) === selected.threadId) : undefined;
	};
	return accessor.get(IChatContextPickService).registerChatContextItem({
		type: 'pickerPick', label: localize('canvas.context', 'Canvas…'), icon: Lxicon.preview, ordinal: -401, presentation: 'inline',
		isEnabled: async () => {
			const context = current();
			if (!context || !canvases.enabled.get()) { return false; }
			if (context.canvases.get()?.some(canvas => canvas.source)) { return true; }
			if (!context.definitionProvider) { return false; }
			const definitions = await context.definitionProvider.listCanvases();
			const selected = current();
			return !!selected && isCanvasOwner(selected.owner, context.owner) && definitions?.some(isOpenableExtensionCanvasDefinition) === true;
		},
		asPicker: () => {
			const context = current();
			const isCurrent = () => {
				const selected = current();
				return !!context && !!selected && isCanvasOwner(context.owner, selected.owner);
			};
			const lifetime = new DisposableStore();
			const invalidated = observableSignalFromEvent(lifetime, Event.any(contexts.onDidChangeVisibility, context?.definitionProvider?.onDidChangeDefinitions ?? Event.None));
			const definitions = lifetime.add(instantiation.createInstance(CanvasDefinitionStore, (reader: IReader) => {
				invalidated.read(reader);
				return context?.definitionProvider && canvases.enabled.read(reader) && isCurrent() ? { owner: context.owner, listCanvases: () => context.definitionProvider!.listCanvases() } : undefined;
			}, 'Canvas context picker'));
			return {
				placeholder: localize('canvas.pick', 'Open a Canvas from a visible conversation'), dispose: () => lifetime.dispose(),
				picks: () => derived(reader => {
					invalidated.read(reader);
					const live = context && canvases.enabled.read(reader) && isCurrent() ? context.canvases.read(reader)?.filter(canvas => canvas.source) ?? [] : [];
					const labels = getCanvasInstanceLabels(live);
					const registered = definitions.definitions.read(reader).filter(definition => !live.some(canvas => canvas.instanceId === getCanvasDefinitionInstanceId(definition)));
					const names = getCanvasDefinitionLabels(registered);
					const picks: ChatContextPick[] = [
						...live.map((canvas, index) => ({ label: labels[index]!, description: canvas.status, asAttachment: async () => { if (context && isCurrent() && canvases.isOwnerPresentable({ ...context.owner, canvas: canvas.resource })) { await canvases.revealCanvas({ ...context.owner, canvas: canvas.resource }); } return 'noop' as const; } })),
						...registered.map((definition, index) => ({ label: names[index]!, description: definition.extensionName ?? definition.extensionId, asAttachment: async () => { if (context && isCurrent()) { await context.definitionProvider!.openCanvas(definition, getCanvasDefinitionInstanceId(definition)); } return 'noop' as const; } })),
					];
					return { busy: false, picks };
				}),
			};
		},
	});
}

/** Selecting a Canvas runs its action without changing the composer's attachment model. */
export async function showCanvasContextPicker(accessor: ServicesAccessor, owner?: ICanvasOwner): Promise<void> {
	const contexts = accessor.get(ICanvasContextService);
	const canvases = accessor.get(ICanvasService);
	const navigation = accessor.get(IChatSessionNavigationService);
	const active = navigation.getActiveConversation();
	const candidates = contexts.contexts.get().filter(context => contexts.isOwnerVisible(context.owner));
	const context = candidates.find(context => owner ? isCanvasOwner(context.owner, owner) : active?.sessionId === context.owner.session.path.slice(1) && active.threadId === context.owner.chat.path.slice(1));
	if (!context || !canvases.enabled.get()) { return; }
	const isCurrent = () => {
		const selected = navigation.getActiveConversation();
		return contexts.isOwnerVisible(context.owner) && (owner !== undefined || selected?.sessionId === context.owner.session.path.slice(1) && selected.threadId === context.owner.chat.path.slice(1));
	};
	using resources = new DisposableStore();
	const invalidated = observableSignalFromEvent(resources, Event.any(contexts.onDidChangeVisibility, context.definitionProvider?.onDidChangeDefinitions ?? Event.None));
	const store = resources.add(accessor.get(IInstantiationService).createInstance(CanvasDefinitionStore, (reader: IReader) => {
		invalidated.read(reader);
		return isCurrent() && context.definitionProvider ? { owner: context.owner, listCanvases: () => context.definitionProvider!.listCanvases() } : undefined;
	}, 'Canvas picker'));
	type Item = { label: string; description?: string; detail?: string; run(): Promise<void>; };
	const picker = resources.add(accessor.get(IQuickInputService).createQuickPick<Item>());
	picker.placeholder = picker.ariaLabel = localize('canvas.pick', 'Open a Canvas from a visible conversation');
	resources.add(autorun(reader => {
		invalidated.read(reader);
		contexts.contexts.read(reader);
		if (!canvases.enabled.read(reader) || !isCurrent()) { picker.hide(); return; }
		const live = context.canvases.read(reader)?.filter(canvas => canvas.source !== undefined) ?? [];
		const definitions = store.definitions.read(reader).filter(definition => !live.some(canvas => canvas.instanceId === getCanvasDefinitionInstanceId(definition)));
		const definitionLabels = getCanvasDefinitionLabels(definitions);
		const liveLabels = getCanvasInstanceLabels(live);
		picker.items = [
			...live.map((canvas, index) => ({ label: liveLabels[index]!, description: canvas.status ?? canvas.instanceId, run: () => canvases.revealCanvas({ ...context.owner, canvas: canvas.resource }) })),
			...definitions.map((definition, index) => ({ label: definitionLabels[index]!, description: definition.extensionName ?? definition.extensionId, detail: definition.description, run: () => context.definitionProvider!.openCanvas(definition, getCanvasDefinitionInstanceId(definition)) })),
		];
	}));
	const selected = await new Promise<Item | undefined>(resolve => {
		resources.add(picker.onDidAccept(() => { resolve(picker.selectedItems[0] ?? picker.activeItems[0]); picker.hide(); }));
		resources.add(picker.onDidHide(() => resolve(undefined)));
		picker.show();
	});
	if (selected && canvases.enabled.get() && isCurrent()) { await selected.run(); }
}
