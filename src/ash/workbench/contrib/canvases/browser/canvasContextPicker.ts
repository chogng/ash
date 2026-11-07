import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { autorun, derived, observableSignalFromEvent, type IReader } from '../../../../base/common/observable.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IInstantiationService, type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { isCanvasOwner, type ICanvasOwner } from '../../../common/canvasReference.js';
import {
	ICanvasContextService, ICanvasService, getCanvasDefinitionInstanceId, getCanvasDefinitionLabels, getCanvasInstanceLabels,
	getPresentableCanvasTargets, isOpenableExtensionCanvasDefinition,
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
export async function showCanvasContextPicker(accessor: ServicesAccessor, getActiveOwner?: () => ICanvasOwner | undefined): Promise<void> {
	const contexts = accessor.get(ICanvasContextService);
	const canvases = accessor.get(ICanvasService);
	const navigation = getActiveOwner ? undefined : accessor.get(IChatSessionNavigationService);
	const isSelected = (candidate: ICanvasOwner): boolean => {
		if (getActiveOwner) {
			const owner = getActiveOwner();
			return !!owner && isCanvasOwner(candidate, owner);
		}
		const active = navigation?.getActiveConversation();
		return active?.sessionId === candidate.session.path.slice(1) && active.threadId === candidate.chat.path.slice(1);
	};
	const context = contexts.contexts.get().find(context => contexts.isOwnerVisible(context.owner) && isSelected(context.owner));
	if (!context || !canvases.enabled.get()) { return; }
	const isCurrent = () => contexts.isOwnerVisible(context.owner) && isSelected(context.owner);
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
		const targets = getPresentableCanvasTargets(canvases, context.owner, live, reader);
		// A live Canvas may already be shown in a fixed page. Its definition still represents that same instance.
		const definitions = store.definitions.read(reader).filter(definition => !live.some(canvas => canvas.instanceId === getCanvasDefinitionInstanceId(definition)));
		const definitionLabels = getCanvasDefinitionLabels(definitions);
		const liveLabels = getCanvasInstanceLabels(targets.map(target => target.canvas));
		picker.items = [
			...targets.map(({ canvas, reference }, index) => ({
				label: liveLabels[index]!,
				description: canvas.status ?? canvas.instanceId,
				run: async () => {
					if (canvases.isOwnerPresentable(reference)) { await canvases.revealCanvas(reference); }
				},
			})),
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
