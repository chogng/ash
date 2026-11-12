import { addDisposableListener } from '../../../../base/browser/dom.js';
import { toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { autorun, derived, observableFromEvent, type IObservable, type IReader } from '../../../../base/common/observable.js';
import { observableConfigValue } from '../../../../platform/observable/common/platformObservableUtils.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { IAccessibleViewService, type AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { createServiceIdentifier, IInstantiationService, type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import type { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextMenuService, IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { ChatWidget, type IChatWidgetModel } from '../../../../workbench/contrib/chat/browser/widget/chatWidget.js';
import type { ChatInputDelegate } from '../../../../workbench/contrib/chat/browser/widget/input/chatInput.js';
import type { ModelRef } from '../../../../platform/models/common/agentModels.js';
import type { ModelCatalogEntry } from '../../../../workbench/services/chat/common/modelCatalog.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { ChatWelcomeTitle } from './chatWelcomeTitle.js';
import { ChatPromptStarters, getChatPromptStartersHelp } from './chatPromptStarters.js';
import { IChatEntityDetails, type ChatEntityDetailsSource } from './chatEntityDetails.js';
import type { IChatWidgetViewOptions } from '../../../../workbench/contrib/chat/browser/chat.js';
import type { IChatListItem } from '../../../../workbench/contrib/chat/common/model/chatViewModel.js';
import { ReplyChatInputFactory, type ReplyChatDraftPicker } from './replyChatInput.js';
import { ChatInputArtifactPill, getArtifactDraftHelp, type ArtifactDraftModel } from './chatInputArtifactPill.js';
import { ChatView, NewChatView } from './chatView.js';

export interface ICompactChatModel extends IChatWidgetModel, ArtifactDraftModel {
	getEntityDetailsSource?(item: IChatListItem): ChatEntityDetailsSource | undefined;
	newChat(): void;
	readWelcomeDraft(reader: IReader): { readonly id: string; readonly revision: number; } | undefined;
}

/** Supplies model options that can open a draft in another conversation source. */
export interface ChatDraftModelSource {
	readonly models: IObservable<readonly ModelCatalogEntry[]>;
	initialize(): void;
	selectModel(model: ModelRef, source: ICompactChatModel): Promise<void>;
}

export interface IChatViewSource {
	readonly id: string;
	readonly rootClass: string;
	readonly title: () => string;
	readonly inputLabel: () => string;
	readonly model: SyncDescriptor<ICompactChatModel>;
	readonly scopedServices?: (accessor: ServicesAccessor) => ServiceCollection;
	readonly persistentDraftScope?: string;
	readonly useWorkbenchModelManagement?: true;
	readonly explicitModelSelection?: true;
	readonly literalServerCommands?: true;
	readonly advanceWelcomePhrase?: false;
	readonly createDraftPicker?: (instantiation: IInstantiationService, footer: HTMLElement, visible: IObservable<boolean>, model: ICompactChatModel) => ReplyChatDraftPicker;
	readonly accessibility: {
		readonly focusContext: string;
		readonly verbositySetting: AccessibilityVerbositySettingId;
		readonly hint: () => string;
	};
	readonly scrollOptimizationSetting?: string;
}

/** Creates chat views with the selected model source and presentation capabilities. */
export interface IChatViewFactory {
	registerSource(id: string, source: IChatViewSource): IDisposable;
	createSessionChatView(container: HTMLElement, options: ConstructorParameters<typeof NewChatView>[1]): NewChatView;
	createChatView(sourceId: string, container: HTMLElement): ChatView;
}

export const IChatViewFactory = createServiceIdentifier<IChatViewFactory>('sessionsChatViewFactory');

export class ChatViewFactory implements IChatViewFactory {
	private readonly sources = new Map<string, IChatViewSource>();

	constructor(@IInstantiationService private readonly instantiation: IInstantiationService) { }

	registerSource(id: string, source: IChatViewSource): IDisposable {
		if (this.sources.has(id)) throw new Error(`Chat view source already registered: ${id}`);
		this.sources.set(id, source);
		return toDisposable(() => this.sources.delete(id));
	}

	createSessionChatView(container: HTMLElement, options: ConstructorParameters<typeof NewChatView>[1]): NewChatView {
		return this.instantiation.createInstance(NewChatView, container, options);
	}

	createChatView(sourceId: string, container: HTMLElement): ChatView {
		const options = this.sources.get(sourceId);
		if (!options) throw new Error(`Unknown Chat view source: ${sourceId}`);
		return this.instantiation.createInstance(CompactChatWidgetFactory).createView(container, options);
	}
}

/** Assembles the compact composer after the window's editor and chat services are available. */
class CompactChatWidgetFactory {
	constructor(
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IContextMenuService private readonly menus: IContextMenuService,
		@IContextViewService private readonly contextViews: IContextViewService,
		@ICommandService private readonly commands: ICommandService,
		@IAccessibleViewService private readonly accessibleViews: IAccessibleViewService,
		@INotificationService private readonly notifications: INotificationService,
		@IOpenerService private readonly opener: IOpenerService,
		@IEditorService private readonly editors: IEditorService,
	) { }

	createView(container: HTMLElement, options: IChatViewSource): ChatView {
		return new ChatView(container, (root, owner, shown) => {
			const contextKeys = owner.add(this.contextKeys.createScoped(root));
			contextKeys.createKey(options.accessibility.focusContext, true);
			// Nested input editors must inherit this page's accessibility context.
			const services = options.scopedServices
				? this.instantiation.invokeFunction(options.scopedServices)
				: new ServiceCollection();
			services.set(IContextKeyService, contextKeys);
			const instantiation = owner.add(this.instantiation.createChild(services));
			const model = instantiation.createInstance(options.model);
			try {
				const entityDetails = model.getEntityDetailsSource && instantiation.getOptional(IChatEntityDetails);
				const createDraftPicker = options.createDraftPicker;
				const inputFactory = instantiation.createInstance(ReplyChatInputFactory);
				const welcome = owner.add(instantiation.createInstance(ChatWelcomeTitle, (reader: IReader) => model.readWelcomeDraft(reader), shown, options.advanceWelcomePhrase !== false));
				const scrollOptimization = options.scrollOptimizationSetting
					? observableConfigValue(options.scrollOptimizationSetting, false, this.configuration)
					: undefined;
				if (scrollOptimization) {
					owner.add(autorun(reader => {
						root.classList.toggle('ash-chat-defer-completed', scrollOptimization.read(reader));
					}));
				}
				owner.add(addDisposableListener(root, 'focusin', event => {
					const { hint, verbositySetting } = options.accessibility;
					if (!root.contains(event.relatedTarget as Node) && this.configuration.getValue<boolean>(verbositySetting)) {
						status(hint());
					}
				}));
				return instantiation.createInstance(ChatWidget<ICompactChatModel>,
					root, options.id, model, () => model.newChat(),
					this.menus, this.contextViews, this.commands, this.accessibleViews, this.notifications,
					this.opener, this.editors, undefined,
					(container: HTMLElement, delegate: ChatInputDelegate) => {
						const input = inputFactory.create(container, delegate, model, {
							inputLabel: options.inputLabel(),
							explicitModelSelection: options.explicitModelSelection,
							literalServerCommands: options.literalServerCommands,
							useWorkbenchModelManagement: options.useWorkbenchModelManagement,
							persistentDraftScope: options.persistentDraftScope,
							createDraftPicker: createDraftPicker && (footer => createDraftPicker(instantiation, footer, shown, model)),
							accessibilityHelp: () => `${getChatPromptStartersHelp()}\n${getArtifactDraftHelp()}`,
						});
						owner.add(new ChatInputArtifactPill(input, model));
						input.element.classList.add('chat-composer');
						const starters = owner.add(new ChatPromptStarters(input.element, input));
						const canShowStarters = observableFromEvent(owner, model.onDidChange, () => {
							const { aiDisabled, interaction, phase } = model.inputState;
							return !aiDisabled && !interaction && phase !== 'submitting' && model.items.length === 0;
						});
						owner.add(autorun(reader => {
							const draft = model.readWelcomeDraft(reader);
							starters.setDraft(shown.read(reader) && canShowStarters.read(reader) ? draft?.id : undefined);
						}));
						return input;
					}, {
						showPromptTimeline: true,
						inspectResponseEntity: entityDetails && (async (item, entity, anchor) => {
							const source = model.getEntityDetailsSource?.(item);
							if (source) await entityDetails.open(source, entity, anchor);
						}),
						welcomeTitle: welcome.title,
						codeBlockPresentation: 'card',
						virtualizeHistoryFrom: scrollOptimization && derived(reader => scrollOptimization.read(reader) ? 100 : undefined),
					} satisfies IChatWidgetViewOptions);
			} catch (error) {
				model.dispose();
				throw error;
			}
		}, {
			className: `${options.rootClass} ash-compact-chat-view ash-chat-content-layout`,
			label: options.title(),
		});
	}
}
