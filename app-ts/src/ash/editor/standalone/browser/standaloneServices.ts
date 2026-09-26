import { ILanguageFeatureDebounceService, LanguageFeatureDebounceService } from '../../common/services/languageFeatureDebounce.js';
import { StandaloneCodeEditorService } from './standaloneCodeEditorService.js';
import { StandaloneLayoutService } from './standaloneLayoutService.js';
import { IInlineCompletionsService, InlineCompletionsService } from '../../browser/services/inlineCompletionsService.js';
import { MarkerService, IMarkerService } from '../../../platform/markers/common/markers.js';
import { MarkerDecorationsService } from '../../common/services/markerDecorationsService.js';
import { IMarkerDecorationsService } from '../../common/services/markerDecorations.js';
import { Disposable, DisposableStore, toDisposable, type IDisposable } from "../../../base/common/lifecycle.js";
import { IInstantiationService, ServiceContainer, ServiceConstructionDescriptor, type ServiceIdentifier } from "../../../platform/instantiation/common/instantiation.js";
import { IThemeService } from "../../../platform/theme/common/themeService.js";
import { ConfigurationTarget, IConfigurationService, isConfigurationUpdateOverrides, type IConfigurationChangeEvent, type IConfigurationData, type IConfigurationOverrides, type IConfigurationUpdateOptions, type IConfigurationUpdateOverrides, type IConfigurationValue } from '../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../platform/configuration/common/inMemoryConfigurationService.js';
import { ICodeEditorService, type ICodeEditorService as ICodeEditorServiceContract } from '../../browser/services/codeEditorService.js';
import { type LanguageCompletionWorkerFactory, type SyntaxWorkerFactory } from '../../common/languages.js';
import { VersionedEditorWorkerClient, type VersionedEditorWorkerFactory } from "../../browser/services/editorWorkerService.js";
import { ILanguageFeaturesService } from '../../common/services/languageFeatures.js';
import { LanguageFeaturesService } from '../../common/services/languageFeaturesService.js';
import { ILanguageService, type IAshLanguageService } from '../../common/languages/language.js';
import { LanguageService } from '../../common/services/languageService.js';
import { ILanguageConfigurationService, LanguageConfigurationService } from '../../common/languages/languageConfigurationRegistry.js';
import { IModelService } from '../../common/services/model.js';
import { ModelService } from '../../common/services/modelService.js';
import { ITextModelService } from '../../common/services/resolverService.js';
import { InMemoryTextModelService } from '../../common/services/inMemoryTextModelService.js';
import { ITextResourcePropertiesService, type ITextResourcePropertiesService as ITextResourcePropertiesServiceContract } from '../../common/services/textResourceConfiguration.js';
import { isLinux, isMacintosh } from '../../../base/common/platform.js';
import type { URI } from '../../../base/common/uri.js';
import { IStandaloneThemeService } from "../common/standaloneTheme.js";
import { StandaloneThemeService } from "./standaloneThemeService.js";
import { Emitter, Event } from '../../../base/common/event.js';
import { IWorkspaceContextService, WorkbenchState, type IWorkspace, type IWorkspaceFolder } from '../../../platform/workspace/common/workspace.js';
import { ILogService, NullLoggerService } from '../../../platform/log/common/log.js';
import { BrowserClipboardService } from '../../../platform/clipboard/browser/browserClipboardService.js';
import { IClipboardService } from '../../../platform/clipboard/common/clipboardService.js';
import { ContextKeyService, IContextKeyService } from "../../../platform/contextkey/browser/contextKeyService.js";
import { FormattingConflicts } from '../../contrib/format/browser/format.js';
import { addDisposableListener, stopEvent } from '../../../base/browser/dom.js';
import { ContextView } from '../../../base/browser/ui/contextview/contextview.js';
import { RunOnceScheduler } from '../../../base/common/async.js';
import { parseKeybinding } from '../../../base/common/keybindingParser.js';
import { type Keybinding, type KeybindingEvent, type ResolvedKeybinding, resolveKeybinding } from '../../../base/common/keybindings.js';
import { CommandsRegistry, ICommandService, type ICommandEvent } from '../../../platform/commands/common/commands.js';
import { IMenuService } from '../../../platform/actions/common/actions.js';
import { MenuService } from '../../../platform/actions/common/menuService.js';
import type { Context, IContextKey } from '../../../platform/contextkey/common/contextkey.js';
import { BrowserContextMenuService } from '../../../platform/contextview/browser/contextMenuService.js';
import { IContextMenuService, IContextViewService } from '../../../platform/contextview/browser/contextView.js';
import { HoverService, IHoverService } from '../../../platform/hover/browser/hoverService.js';
import { IKeybindingService, KeybindingContextKeys } from '../../../platform/keybinding/common/keybinding.js';
import { KeybindingResolver, KeybindingResolveKind } from '../../../platform/keybinding/common/keybindingResolver.js';
import { INotificationService, NotificationSeverity, type NotificationAction, type NotificationHandle, type NotificationItem, type NotificationOptions } from '../../../platform/notification/common/notification.js';
import { bindColorTheme } from '../../../platform/theme/browser/themeStyles.js';
import { IAccessibilityService } from '../../../platform/accessibility/common/accessibility.js';
import { AccessibilityService } from '../../../platform/accessibility/browser/accessibilityService.js';
import '../../../base/browser/ui/contextview/contextview.css';
import '../../../base/browser/ui/menu/menu.css';
import '../../../base/browser/ui/button/button.css';
import '../../../base/browser/ui/keybindinglabel/keybindinglabel.css';
import { IQuickInputService } from '../../../platform/quickinput/common/quickInput.js';
import { ILayoutService } from '../../../platform/layout/browser/layoutService.js';
import { StandaloneQuickInputService } from './quickInput/standaloneQuickInputService.js';
import { DefaultDropProvidersFeature, DefaultPasteProvidersFeature } from '../../contrib/dropOrPasteInto/browser/defaultProviders.js';
import { IBulkEditService, ResourceEdit, ResourceTextEdit, type IBulkEditOptions, type IBulkEditPreviewHandler, type IBulkEditResult } from '../../browser/services/bulkEditService.js';
import { EditOperation } from '../../common/core/editOperation.js';
import { Range } from '../../common/core/range.js';
import { type ITextModel } from '../../common/model.js';

export class StandaloneWorkspaceContextService implements IWorkspaceContextService {
	readonly onDidChangeWorkspace = Event.None;
	private readonly workspace: IWorkspace = Object.freeze({ id: 'standalone', folders: [] });

	getWorkspace(): IWorkspace { return this.workspace; }
	getWorkbenchState(): WorkbenchState { return WorkbenchState.EMPTY; }
	getWorkspaceFolder(_resource: URI): IWorkspaceFolder | null { return null; }
}

/** Applies editor-local workspace edits for embedded editors. */
export class StandaloneBulkEditService implements IBulkEditService {
	declare readonly _serviceBrand: undefined;

	constructor(@ICodeEditorService private readonly editors: ICodeEditorServiceContract) {}

	hasPreviewHandler(): boolean { return false; }
	setPreviewHandler(_handler: IBulkEditPreviewHandler): IDisposable {
		throw new Error('Bulk edit preview is unavailable in an embedded editor');
	}

	async apply(value: ResourceEdit[] | import('../../common/languages.js').LanguageWorkspaceEdit, options: IBulkEditOptions = {}): Promise<IBulkEditResult> {
		const edits = Array.isArray(value) ? value : ResourceEdit.convert(value);
		const byModel = new Map<ITextModel, ResourceTextEdit[]>();
		for (const edit of edits) {
			if (!(edit instanceof ResourceTextEdit)) throw new Error('Embedded editors only support text workspace edits');
			const model = [options.editor, ...this.editors.listCodeEditors()]
				.map(editor => editor?.getModel())
				.find(candidate => candidate?.uri.toString() === edit.resource.toString());
			if (!model) throw new Error(`No embedded editor owns ${edit.resource.toString()}`);
			if (edit.versionId !== undefined && model.getVersionId() !== edit.versionId) throw new Error('Workspace edit target changed');
			const group = byModel.get(model) ?? [];
			group.push(edit);
			byModel.set(model, group);
		}
		if (options.token?.aborted || edits.length === 0) return { ariaSummary: 'No edits were applied', isApplied: false };
		const applied = new Map<ITextModel, { readonly text: string; readonly alternativeVersionId: number }>();
		try {
			for (const [model, group] of byModel) {
				model.pushStackElement();
				model.pushEditOperations([], group.map(edit => EditOperation.replaceMove(Range.lift(edit.textEdit.range), edit.textEdit.text)), () => []);
				model.pushStackElement();
				applied.set(model, { text: model.getValue(), alternativeVersionId: model.getAlternativeVersionId() });
			}
		} catch (error) {
			for (const model of [...applied.keys()].reverse()) model.undo();
			throw error;
		}
		return {
			ariaSummary: `${edits.length} edits applied`,
			isApplied: true,
			undo: async () => {
				for (const [model, state] of applied) {
					if (model.getValue() !== state.text || model.getAlternativeVersionId() !== state.alternativeVersionId) {
						throw new Error('Workspace edit target changed before replacement');
					}
				}
				for (const model of [...applied.keys()].reverse()) model.undo();
			},
		};
	}
}

export interface StandaloneServiceOverrides {
	readonly languageService?: IAshLanguageService;
	readonly languageConfigurationService?: ILanguageConfigurationService;
	readonly languageFeaturesService?: ILanguageFeaturesService;
	readonly editorWorkerFactory?: VersionedEditorWorkerFactory;
	readonly syntaxWorkerFactory?: SyntaxWorkerFactory;
	/** Explicit Worker authority that replaces the local completion provider registry. */
	readonly completionWorkerFactory?: LanguageCompletionWorkerFactory;
}

export class StandaloneServiceCollection extends ServiceContainer {
	readonly modelService: ModelService;
	readonly languageService: IAshLanguageService;
	readonly languageConfigurationService: ILanguageConfigurationService;
	readonly languageFeaturesService: ILanguageFeaturesService;
	readonly themeService: IStandaloneThemeService;
	readonly syntaxWorkerFactory: SyntaxWorkerFactory | undefined;
	readonly editorWorkerFactory: VersionedEditorWorkerFactory;
	readonly completionWorkerFactory: LanguageCompletionWorkerFactory | undefined;
	readonly codeEditorService: ICodeEditorServiceContract;

	constructor(overrides: StandaloneServiceOverrides) {
		if (overrides.languageFeaturesService && !overrides.languageConfigurationService) throw new TypeError("Standalone language feature overrides require a language configuration service");
		super();
		this.registerInstance(ILogService, new NullLoggerService());
		this.registerSingleton(IInlineCompletionsService, () => this.createInstance(InlineCompletionsService));
		this.registerSingleton(ILanguageFeatureDebounceService, () => this.createInstance(LanguageFeatureDebounceService));
		this.registerSingleton(IContextKeyService, () => new ContextKeyService());
		this.registerSingleton(ICommandService, () => this.createInstance(StandaloneCommandService));
		this.registerSingleton(INotificationService, () => this.createInstance(StandaloneNotificationService));
		this.registerSingleton(IKeybindingService, () => this.createInstance(StandaloneKeybindingService));
		this.registerSingleton(IMenuService, () => this.createInstance(new ServiceConstructionDescriptor(MenuService, {
			serviceDependencies: [ICommandService, IContextKeyService],
		})));
		this.registerSingleton(IContextViewService, () => this.createInstance(StandaloneContextViewService));
		this.registerSingleton(IContextMenuService, () => this.createInstance(new ServiceConstructionDescriptor(BrowserContextMenuService, {
			serviceDependencies: [IMenuService, IContextKeyService, IKeybindingService, IContextViewService, INotificationService],
		})));
		this.registerSingleton(IHoverService, accessor => new HoverService(
			accessor.get(IConfigurationService),
			accessor.get(IContextViewService),
			accessor.get(IContextMenuService),
		));
		this.registerSingleton(IMarkerService, () => new MarkerService());
		this.registerSingleton(IMarkerDecorationsService, () => this.createInstance(MarkerDecorationsService));
		this.registerInstance(IClipboardService, new BrowserClipboardService(window.navigator.clipboard));
		this.registerSingleton(ICodeEditorService, () => this.createInstance(StandaloneCodeEditorService));
		this.registerSingleton(ILayoutService, () => this.createInstance(StandaloneLayoutService));
		this.registerSingleton(IQuickInputService, () => this.createInstance(StandaloneQuickInputService));
		this.registerSingleton(IBulkEditService, () => this.createInstance(StandaloneBulkEditService));
		this.codeEditorService = this.get(ICodeEditorService);
		this.editorWorkerFactory = overrides.editorWorkerFactory ?? (model => new VersionedEditorWorkerClient(model));
		this.syntaxWorkerFactory = overrides.syntaxWorkerFactory;
		this.completionWorkerFactory = overrides.completionWorkerFactory;
		const configurationService = this._register(new StandaloneConfigurationService());
		this.registerInstance(IConfigurationService, configurationService);
		this.registerSingleton(IAccessibilityService, accessor => new AccessibilityService({
			root: document.body,
			contextKeyService: accessor.get(IContextKeyService),
			configurationService: accessor.get(IConfigurationService),
		}));
		this.registerSingleton(ITextResourcePropertiesService, accessor => new StandaloneResourcePropertiesService(accessor.get(IConfigurationService)));
		if (overrides.languageService) this.registerInstance(ILanguageService, overrides.languageService);
		else this.registerSingleton(ILanguageService, () => new LanguageService());
		if (overrides.languageConfigurationService) this.registerInstance(ILanguageConfigurationService, overrides.languageConfigurationService);
		else this.registerSingleton(ILanguageConfigurationService, accessor => new LanguageConfigurationService(
			accessor.get(IConfigurationService),
			accessor.get(ILanguageService),
		));
		if (overrides.languageFeaturesService) this.registerInstance(ILanguageFeaturesService, overrides.languageFeaturesService);
		else this.registerSingleton(ILanguageFeaturesService, () => new LanguageFeaturesService());
		const workspaceContext = new StandaloneWorkspaceContextService();
		this.registerInstance(IWorkspaceContextService, workspaceContext);
		this._register(new DefaultPasteProvidersFeature(this.get(ILanguageFeaturesService), workspaceContext));
		this._register(new DefaultDropProvidersFeature(this.get(ILanguageFeaturesService), workspaceContext));
		this.registerSingleton(IStandaloneThemeService, () => new StandaloneThemeService(window));
		this.themeService = this.get(IStandaloneThemeService);
		this.registerSingleton(IModelService, accessor => new ModelService(
			accessor.get(IConfigurationService),
			accessor.get(ITextResourcePropertiesService),
			accessor.get(ILanguageService),
			accessor.get(ILanguageFeaturesService),
			accessor.get(ILanguageConfigurationService),
			{ syntaxService: { workerFactory: this.syntaxWorkerFactory } },
		));
		this.modelService = this.get(IModelService) as ModelService;
		this.registerSingleton(ITextModelService, () => this.createInstance(InMemoryTextModelService));
		this.languageService = this.get(ILanguageService);
		this.languageConfigurationService = this.get(ILanguageConfigurationService);
		this.languageFeaturesService = this.get(ILanguageFeaturesService);
		this._register(FormattingConflicts.setFormatterSelector(async formatters => formatters[0]));
	}
}

/** Executes a command in this standalone window's service scope. */
export class StandaloneCommandService extends Disposable implements ICommandService {
	private readonly willExecute = this._register(new Emitter<ICommandEvent>());
	private readonly didExecute = this._register(new Emitter<ICommandEvent>());
	readonly onWillExecuteCommand = this.willExecute.event;
	readonly onDidExecuteCommand = this.didExecute.event;

	constructor(@IInstantiationService private readonly instantiationService: IInstantiationService) {
		super();
	}

	async executeCommand<T = unknown>(id: string, ...args: readonly unknown[]): Promise<T> {
		const handler = CommandsRegistry.getCommand(id);
		if (!handler) {
			throw new Error(`Unknown command: ${id}`);
		}
		const event = { commandId: id, args };
		this.willExecute.fire(event);
		const result = this.instantiationService.invokeFunction(handler, ...args) as T | PromiseLike<T>;
		this.didExecute.fire(event);
		return result;
	}
}

/** Resolves registered shortcuts and dispatches them while a standalone editor has text focus. */
export class StandaloneKeybindingService extends Disposable implements IKeybindingService {
	private readonly resolver = new KeybindingResolver();
	private readonly chords: KeybindingEvent[] = [];
	private readonly chordTimeout = this._register(new RunOnceScheduler(() => this.clearChords(), 5000));
	private readonly inChordModeKey: IContextKey<boolean>;
	readonly onDidUpdateKeybindings = this.resolver.onDidChangeKeybindings;

	constructor(
		@ICodeEditorService private readonly editors: ICodeEditorServiceContract,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@ICommandService private readonly commands: ICommandService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		this.inChordModeKey = KeybindingContextKeys.inChordMode.bindTo(contextKeys);
		this._register(toDisposable(() => this.clearChords()));
		this._register(addDisposableListener(document, 'keydown', event => this.dispatch(event), true));
		this._register(addDisposableListener(document, 'focusin', () => this.clearChords()));
		this._register(addDisposableListener(document, 'compositionstart', () => this.clearChords()));
		this._register(addDisposableListener(window, 'blur', () => this.clearChords()));
		this._register(this.resolver.onDidChangeKeybindings(() => this.clearChords()));
	}

	get inChordMode(): boolean { return this.chords.length > 0; }

	resolveKeybinding(keybinding: Keybinding): ResolvedKeybinding { return resolveKeybinding(keybinding); }

	resolveUserBinding(value: string): ResolvedKeybinding | undefined {
		const keybinding = parseKeybinding(value);
		return keybinding ? this.resolveKeybinding(keybinding) : undefined;
	}

	lookupKeybindings(command: string, context = this.contextKeys.getContext(document.activeElement)): readonly ResolvedKeybinding[] {
		return this.resolver.lookupKeybindings(command, context);
	}

	lookupKeybinding(command: string, context: Context = this.contextKeys.getContext(document.activeElement)): ResolvedKeybinding | undefined {
		return this.resolver.lookupKeybinding(command, context);
	}

	private dispatch(event: KeyboardEvent): void {
		if (event.defaultPrevented || event.isComposing || event.getModifierState('AltGraph') || !this.editors.getFocusedCodeEditor()?.hasTextFocus()) {
			return;
		}
		if (['Control', 'Meta', 'Alt', 'Shift'].includes(event.key)) {
			return;
		}
		if (this.inChordMode && event.key === 'Escape') {
			stopEvent(event);
			this.clearChords();
			return;
		}
		const result = this.resolver.resolve(this.contextKeys.getContext(event.target as Node), [...this.chords, event]);
		if (result.kind === KeybindingResolveKind.NoMatch) {
			if (this.inChordMode) {
				stopEvent(event);
			}
			this.clearChords();
			return;
		}
		stopEvent(event);
		if (result.kind === KeybindingResolveKind.MoreChordsNeeded) {
			this.chords.push(event);
			this.inChordModeKey.set(true);
			this.chordTimeout.schedule();
			return;
		}
		this.clearChords();
		if (result.kind === KeybindingResolveKind.Command) {
			void this.commands.executeCommand(result.command, ...result.args).catch(error => this.notifications.error(String(error)));
		}
	}

	private clearChords(): void {
		this.chords.length = 0;
		this.chordTimeout.cancel();
		this.inChordModeKey.reset();
	}
}

/** Standalone notifications are observable and reported to the embedding page's console. */
export class StandaloneNotificationService extends Disposable implements INotificationService {
	private readonly added = this._register(new Emitter<NotificationItem>());
	private readonly removed = this._register(new Emitter<NotificationItem>());
	private readonly items = new Map<number, NotificationItem>();
	private nextId = 1;
	readonly onDidAdd = this.added.event;
	readonly onDidRemove = this.removed.event;

	notify(options: NotificationOptions): NotificationHandle {
		const item: NotificationItem = Object.freeze({ ...options, id: this.nextId++, createdAt: Date.now() });
		this.items.set(item.id, item);
		this.added.fire(item);
		switch (item.severity) {
			case NotificationSeverity.Error:
				console.error(item.message);
				break;
			case NotificationSeverity.Warning:
				console.warn(item.message);
				break;
			case NotificationSeverity.Info:
				console.info(item.message);
				break;
		}
		return { item, close: () => { this.remove(item.id); } };
	}

	info(message: string, actions?: readonly NotificationAction[]): NotificationHandle {
		return this.notify({ severity: NotificationSeverity.Info, message, actions });
	}
	warning(message: string, actions?: readonly NotificationAction[]): NotificationHandle {
		return this.notify({ severity: NotificationSeverity.Warning, message, actions });
	}
	error(message: string, actions?: readonly NotificationAction[]): NotificationHandle {
		return this.notify({ severity: NotificationSeverity.Error, message, actions });
	}
	getNotifications(): readonly NotificationItem[] { return [...this.items.values()]; }
	remove(id: number): boolean {
		const item = this.items.get(id);
		if (!item) {
			return false;
		}
		this.items.delete(id);
		this.removed.fire(item);
		return true;
	}
	clear(): void {
		for (const id of this.items.keys()) {
			this.remove(id);
		}
	}
	protected override disposeCore(): void {
		this.clear();
		super.disposeCore();
	}
}

class StandaloneContextViewService extends ContextView implements IContextViewService {
	get container(): HTMLElement { return this.element; }

	constructor(@IThemeService themeService: IThemeService) {
		super(document.body);
		this._register(bindColorTheme(themeService, this.element));
	}
}

class StandaloneConfigurationService extends Disposable implements IConfigurationService {
	readonly _serviceBrand = undefined;
	private readonly source = this._register(new InMemoryConfigurationService());
	readonly onDidChangeConfiguration: Event<IConfigurationChangeEvent> = (listener, thisArgs, disposables) => this.source.onDidChangeConfiguration(event => listener.call(thisArgs, {
		...event,
		affectsConfiguration: (section, overrides) => event.affectsConfiguration(section, withoutResource(overrides)),
	}), undefined, disposables);

	getValue<T>(): T;
	getValue<T>(section: string): T;
	getValue<T>(overrides: IConfigurationOverrides): T;
	getValue<T>(section: string, overrides: IConfigurationOverrides): T;
	getValue<T>(arg1?: string | IConfigurationOverrides, arg2?: IConfigurationOverrides): T {
		if (typeof arg1 === 'string') return arg2 ? this.source.getValue<T>(arg1, withoutResource(arg2)) : this.source.getValue<T>(arg1);
		return arg1 ? this.source.getValue<T>(withoutResource(arg1)) : this.source.getValue<T>();
	}

	updateValue(key: string, value: unknown): Promise<void>;
	updateValue(key: string, value: unknown, target: ConfigurationTarget): Promise<void>;
	updateValue(key: string, value: unknown, overrides: IConfigurationOverrides | IConfigurationUpdateOverrides): Promise<void>;
	updateValue(key: string, value: unknown, overrides: IConfigurationOverrides | IConfigurationUpdateOverrides, target: ConfigurationTarget, options?: IConfigurationUpdateOptions): Promise<void>;
	updateValue(key: string, value: unknown, arg3?: ConfigurationTarget | IConfigurationOverrides | IConfigurationUpdateOverrides, arg4?: ConfigurationTarget, options?: IConfigurationUpdateOptions): Promise<void> {
		if (typeof arg3 === 'number') return this.source.updateValue(key, value, arg3);
		if (!arg3) return this.source.updateValue(key, value);
		const overrides = withoutResource(arg3);
		return arg4 === undefined
			? this.source.updateValue(key, value, overrides)
			: this.source.updateValue(key, value, overrides, arg4, options);
	}

	inspect<T>(key: string, overrides?: IConfigurationOverrides): IConfigurationValue<Readonly<T>> {
		return this.source.inspect<T>(key, withoutResource(overrides));
	}

	reloadConfiguration(target?: ConfigurationTarget | IWorkspaceFolder): Promise<void> { return this.source.reloadConfiguration(target); }
	keys(): ReturnType<IConfigurationService['keys']> { return this.source.keys(); }
	getConfigurationData(): IConfigurationData { return this.source.getConfigurationData(); }
}

function withoutResource(overrides: IConfigurationOverrides): IConfigurationOverrides;
function withoutResource(overrides: IConfigurationUpdateOverrides): IConfigurationUpdateOverrides;
function withoutResource(overrides: IConfigurationOverrides | undefined): IConfigurationOverrides | undefined;
function withoutResource(overrides: IConfigurationOverrides | IConfigurationUpdateOverrides | undefined): IConfigurationOverrides | IConfigurationUpdateOverrides | undefined {
	if (!overrides) return undefined;
	return isConfigurationUpdateOverrides(overrides)
		? { overrideIdentifiers: overrides.overrideIdentifiers }
		: { overrideIdentifier: overrides.overrideIdentifier };
}

class StandaloneResourcePropertiesService implements ITextResourcePropertiesServiceContract {
	readonly _serviceBrand: undefined;

	constructor(private readonly configurationService: IConfigurationService) {}

	getEOL(resource: URI, language?: string): string {
		const eol = this.configurationService.getValue<'auto' | '\n' | '\r\n'>('files.eol', { overrideIdentifier: language, resource });
		return eol === 'auto' ? (isLinux || isMacintosh ? '\n' : '\r\n') : eol;
	}
}

let services: StandaloneServiceCollection | undefined;
const initialized = new Emitter<void>();

/** One browser-window service scope. The first editor may provide service overrides. */
export namespace StandaloneServices {
	export function initialize(overrides: StandaloneServiceOverrides = {}): StandaloneServiceCollection {
		if (services) {
			if (Object.keys(overrides).length > 0) throw new Error("Standalone services are already initialized");
			return services;
		}
		services = new StandaloneServiceCollection(overrides);
		initialized.fire();
		return services;
	}

	export function get<T>(serviceId: ServiceIdentifier<T>): T {
		return initialize().get(serviceId);
	}

	export function withServices(callback: () => IDisposable): IDisposable {
		if (services) {
			return callback();
		}
		const resources = new DisposableStore();
		const listener = resources.add(initialized.event(() => {
			listener.dispose();
			resources.add(callback());
		}));
		return resources;
	}
}
