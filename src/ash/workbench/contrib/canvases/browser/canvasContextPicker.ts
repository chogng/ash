import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { autorun, derived, observableSignalFromEvent, type IReader } from '../../../../base/common/observable.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IInstantiationService, type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ICanvasContextService, ICanvasService, getCanvasDefinitionInstanceId, getCanvasDefinitionLabels, getCanvasInstanceLabels, isCanvasOwner, type ICanvasOwner } from '../common/canvas.js';
import { CanvasDefinitionStore } from '../common/canvasDefinitionStore.js';
import { IChatWidgetService } from '../../chat/browser/chat.js';
import { localize } from '../../../../nls.js';
import { IChatContextPickService, type ChatContextPick } from '../../chat/browser/attachments/chatContextPickService.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { Event } from '../../../../base/common/event.js';

/** Add context invokes Canvas actions and returns `noop`, leaving the draft and attachments untouched. */
export function registerCanvasContextPicker(accessor: ServicesAccessor) {
	const contexts = accessor.get(ICanvasContextService);
	const canvases = accessor.get(ICanvasService);
	const widgets = accessor.get(IChatWidgetService);
	const current = () => {
		const focused = widgets.lastFocusedWidget;
		return contexts.contexts
			.get()
			.find(
				context => contexts.isOwnerVisible(context.owner) && (!focused || (context.owner.session.path.slice(1) === focused.sessionId && context.owner.chat.path.slice(1) === focused.threadId)),
			);
	};
	return accessor.get(IChatContextPickService).registerChatContextItem({
		type: 'pickerPick',
		label: localize('canvas.open', 'Open Canvas…'),
		icon: Lxicon.preview,
		ordinal: -401,
		presentation: 'inline',
		isEnabled: async () => {
			const context = current();
			if (!context || !canvases.enabled.get()) {
				return false;
			}
			if (context.canvases.get()?.some(canvas => canvas.source)) {
				return true;
			}
			if (!context.definitionProvider) {
				return false;
			}
			const definitions = await context.definitionProvider.listCanvases();
			return definitions === undefined || definitions.some(definition => !definition.requiresInput);
		},
		asPicker: () => {
			const context = current();
			const lifetime = new DisposableStore();
			const invalidated = observableSignalFromEvent(lifetime, Event.any(contexts.onDidChangeVisibility, context?.definitionProvider?.onDidChangeDefinitions ?? Event.None));
			const definitions = lifetime.add(
				accessor.get(IInstantiationService).createInstance(
					CanvasDefinitionStore,
					(reader: IReader) => {
						invalidated.read(reader);
						return context?.definitionProvider && canvases.enabled.read(reader) && contexts.isOwnerVisible(context.owner)
							? { owner: context.owner, listCanvases: () => context.definitionProvider!.listCanvases() }
							: undefined;
					},
					'Canvas context picker',
				),
			);
			return {
				placeholder: localize('canvas.pick', 'Open a Canvas from a visible conversation'),
				dispose: () => lifetime.dispose(),
				picks: () =>
					derived(reader => {
						invalidated.read(reader);
						const live = context && canvases.enabled.read(reader) && contexts.isOwnerVisible(context.owner) ? (context.canvases.read(reader)?.filter(canvas => canvas.source) ?? []) : [];
						const labels = getCanvasInstanceLabels(live);
						const registered = definitions.definitions.read(reader).filter(definition => !live.some(canvas => canvas.instanceId === getCanvasDefinitionInstanceId(definition)));
						const names = getCanvasDefinitionLabels(registered);
						const picks: ChatContextPick[] = [
							...live.map((canvas, index) => ({
								label: labels[index]!,
								description: canvas.status,
								asAttachment: async () => {
									if (context && canvases.isOwnerPresentable({ ...context.owner, canvas: canvas.resource })) {
										await canvases.revealCanvas({ ...context.owner, canvas: canvas.resource });
									}
									return 'noop' as const;
								},
							})),
							...registered.map((definition, index) => ({
								label: names[index]!,
								description: definition.extensionName ?? definition.extensionId,
								asAttachment: async () => {
									if (context && canvases.enabled.get() && contexts.isOwnerVisible(context.owner)) {
										await context.definitionProvider!.openCanvas(definition, getCanvasDefinitionInstanceId(definition));
									}
									return 'noop' as const;
								},
							})),
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
	const focused = accessor.get(IChatWidgetService).lastFocusedWidget;
	const candidates = contexts.contexts.get().filter(context => contexts.isOwnerVisible(context.owner));
	const context =
		candidates.find(context =>
			owner ? isCanvasOwner(context.owner, owner) : focused?.sessionId === context.owner.session.path.slice(1) && focused.threadId === context.owner.chat.path.slice(1),
		) ?? (!owner ? candidates[0] : undefined);
	if (!context || !canvases.enabled.get()) {
		return;
	}
	using resources = new DisposableStore();
	const invalidated = observableSignalFromEvent(resources, Event.any(contexts.onDidChangeVisibility, context.definitionProvider?.onDidChangeDefinitions ?? Event.None));
	const store = resources.add(
		accessor.get(IInstantiationService).createInstance(
			CanvasDefinitionStore,
			(reader: IReader) => {
				invalidated.read(reader);
				return contexts.isOwnerVisible(context.owner) && context.definitionProvider ? { owner: context.owner, listCanvases: () => context.definitionProvider!.listCanvases() } : undefined;
			},
			'Canvas picker',
		),
	);
	type Item = { label: string; description?: string; detail?: string; run(): Promise<void> };
	const picker = resources.add(accessor.get(IQuickInputService).createQuickPick<Item>());
	picker.placeholder = picker.ariaLabel = localize('canvas.pick', 'Open a Canvas from a visible conversation');
	resources.add(
		autorun(reader => {
			invalidated.read(reader);
			contexts.contexts.read(reader);
			if (!canvases.enabled.read(reader) || !contexts.isOwnerVisible(context.owner)) {
				picker.hide();
				return;
			}
			const live = context.canvases.read(reader)?.filter(canvas => canvas.source !== undefined) ?? [];
			const definitions = store.definitions.read(reader).filter(definition => !live.some(canvas => canvas.instanceId === getCanvasDefinitionInstanceId(definition)));
			const definitionLabels = getCanvasDefinitionLabels(definitions);
			const liveLabels = getCanvasInstanceLabels(live);
			picker.items = [
				...live.map((canvas, index) => ({
					label: liveLabels[index]!,
					description: canvas.status ?? canvas.instanceId,
					run: () => canvases.revealCanvas({ ...context.owner, canvas: canvas.resource }),
				})),
				...definitions.map((definition, index) => ({
					label: definitionLabels[index]!,
					description: definition.extensionName ?? definition.extensionId,
					detail: definition.description,
					run: () => context.definitionProvider!.openCanvas(definition, getCanvasDefinitionInstanceId(definition)),
				})),
			];
		}),
	);
	const selected = await new Promise<Item | undefined>(resolve => {
		resources.add(
			picker.onDidAccept(() => {
				resolve(picker.selectedItems[0] ?? picker.activeItems[0]);
				picker.hide();
			}),
		);
		resources.add(picker.onDidHide(() => resolve(undefined)));
		picker.show();
	});
	if (selected && canvases.enabled.get() && contexts.isOwnerVisible(context.owner)) {
		await selected.run();
	}
}
