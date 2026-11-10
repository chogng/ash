import { addDisposableListener, h, type IDimension } from '../../../../base/browser/dom.js';
import { autorun, derived, observableFromEvent, observableValue, type IObservable, type IReader } from '../../../../base/common/observable.js';
import { observableConfigValue } from '../../../../platform/observable/common/platformObservableUtils.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { IAccessibleViewService, type AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IInstantiationService, type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import type { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { registerEditorPane } from '../../../../workbench/browser/editor.js';
import { EditorPane, EditorPaneMatch } from '../../../../workbench/browser/parts/editor/editorPane.js';
import type { IResourceEditorInput } from '../../../../workbench/common/editor.js';
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
import './media/chatView.css';

export interface IReplyChatEditorModel extends IChatWidgetModel {
	getEntityDetailsSource?(item: IChatListItem): ChatEntityDetailsSource | undefined;
	newChat(): void;
	readWelcomeDraft(reader: IReader): { readonly id: string; readonly revision: number; } | undefined;
}

/** Supplies model options that can open a draft in another conversation source. */
export interface ChatDraftModelSource {
	readonly models: IObservable<readonly ModelCatalogEntry[]>;
	initialize(): void;
	selectModel(model: ModelRef, source: IReplyChatEditorModel): Promise<void>;
}

export interface ReplyChatEditorOptions {
	readonly id: string;
	readonly scheme: string;
	readonly name: string;
	readonly rootClass: string;
	readonly title: () => string;
	readonly inputLabel: () => string;
	readonly model: SyncDescriptor<IReplyChatEditorModel>;
	readonly scopedServices?: (accessor: ServicesAccessor) => ServiceCollection;
	readonly persistentDraftScope?: string;
	readonly useWorkbenchModelManagement?: true;
	readonly explicitModelSelection?: true;
	readonly literalServerCommands?: true;
	readonly advanceWelcomePhrase?: false;
	readonly createDraftPicker?: (instantiation: IInstantiationService, footer: HTMLElement, visible: IObservable<boolean>, model: IReplyChatEditorModel) => ReplyChatDraftPicker;
	readonly accessibility: {
		readonly focusContext: string;
		readonly verbositySetting: AccessibilityVerbositySettingId;
		readonly hint: () => string;
	};
	readonly scrollOptimizationSetting?: string;
}

export function registerReplyChatEditor(options: ReplyChatEditorOptions): void {
	registerEditorPane({
		id: options.id,
		name: options.name,
		canOpen: input => input.resource.scheme === options.scheme ? EditorPaneMatch.Default : EditorPaneMatch.None,
		create: context => context.instantiationService!.createInstance(ReplyChatEditor, options),
	});
}

/** Owns the compact Sessions editor and consumes the selected reply provider's model. */
export class ReplyChatEditor extends EditorPane {
	readonly id: string;
	private widget: ChatWidget<IReplyChatEditorModel> | undefined;
	private readonly shown = observableValue(this, false);
	constructor(
		private readonly options: ReplyChatEditorOptions,
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
		@IThemeService theme: IThemeService,
		@IStorageService profileStorage: IStorageService,
	) {
		super(options.id, theme, profileStorage);
		this.id = options.id;
	}
	public override create(parent: HTMLElement): void {
		const root = h(parent.ownerDocument, 'section', {
			className: `${this.options.rootClass} ash-reply-chat-editor ash-sessions-chat-content ash-chat-content-layout`,
			attributes: { 'aria-label': this.options.title() },
		});
		root.style.height = '100%';
		parent.append(root);
		super.create(root);
		const contextKeys = this._register(this.contextKeys.createScoped(root));
		contextKeys.createKey(this.options.accessibility.focusContext, true);
		// Nested input editors must inherit this page's accessibility context.
		const services = this.options.scopedServices
			? this.instantiation.invokeFunction(this.options.scopedServices)
			: new ServiceCollection();
		services.set(IContextKeyService, contextKeys);
		const instantiation = this._register(this.instantiation.createChild(services));
		const model = instantiation.createInstance(this.options.model);
		const entityDetails = model.getEntityDetailsSource && instantiation.getOptional(IChatEntityDetails);
		const createDraftPicker = this.options.createDraftPicker;
		const inputFactory = instantiation.createInstance(ReplyChatInputFactory);
		const welcome = this._register(instantiation.createInstance(ChatWelcomeTitle, (reader: IReader) => model.readWelcomeDraft(reader), this.shown, this.options.advanceWelcomePhrase !== false));
		const scrollOptimization = this.options.scrollOptimizationSetting
			? observableConfigValue(this.options.scrollOptimizationSetting, false, this.configuration)
			: undefined;
		try {
			this.widget = this._register(instantiation.createInstance(ChatWidget<IReplyChatEditorModel>,
				root, this.options.id, model, () => model.newChat(),
				this.menus, this.contextViews, this.commands, this.accessibleViews, this.notifications,
				this.opener, this.editors, undefined,
				(container: HTMLElement, delegate: ChatInputDelegate) => {
					const input = inputFactory.create(container, delegate, model, {
						inputLabel: this.options.inputLabel(),
						explicitModelSelection: this.options.explicitModelSelection,
						literalServerCommands: this.options.literalServerCommands,
						useWorkbenchModelManagement: this.options.useWorkbenchModelManagement,
						persistentDraftScope: this.options.persistentDraftScope,
						createDraftPicker: createDraftPicker && (footer => createDraftPicker(instantiation, footer, this.shown, model)),
						accessibilityHelp: getChatPromptStartersHelp,
					});
					input.element.classList.add('chat-composer');
					const starters = this._register(new ChatPromptStarters(input.element, input));
					const canShowStarters = observableFromEvent(this, model.onDidChange, () => {
						const { aiDisabled, interaction, phase } = model.inputState;
						return !aiDisabled && !interaction && phase !== 'submitting' && model.items.length === 0;
					});
					this._register(autorun(reader => {
						const draft = model.readWelcomeDraft(reader);
						starters.setDraft(this.shown.read(reader) && canShowStarters.read(reader) ? draft?.id : undefined);
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
				} satisfies IChatWidgetViewOptions));
		} catch (error) {
			model.dispose();
			throw error;
		}
		if (scrollOptimization) {
			this._register(autorun(reader => {
				root.classList.toggle('ash-chat-defer-completed', scrollOptimization.read(reader));
			}));
		}
		this._register(addDisposableListener(root, 'focusin', event => {
			const { hint, verbositySetting } = this.options.accessibility;
			if (!root.contains(event.relatedTarget as Node) && this.configuration.getValue<boolean>(verbositySetting)) {
				status(hint());
			}
		}));
	}
	public override async setInput(_input: IResourceEditorInput, _signal: AbortSignal): Promise<void> { }
	public override clearInput(): void { }
	public override layout(_dimension: IDimension): void { }
	public override focus(): void { this.widget?.focus(); }
	public override setVisible(visible: boolean): void {
		super.setVisible(visible);
		this.widget?.setVisible(visible);
		this.shown.set(visible, undefined);
	}

}
