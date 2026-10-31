import { addDisposableListener, h, isHTMLElement } from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { IconLabel } from '../../../../../base/browser/ui/iconlabel/iconlabel.js';
import { InputBox } from '../../../../../base/browser/ui/inputbox/inputbox.js';
import { Switch } from '../../../../../base/browser/ui/toggle/toggle.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { createUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { SecretStorageError } from '../../../../../platform/secrets/common/secrets.js';
import { defaultButtonStyles, defaultInputBoxStyles, defaultToggleStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import type { ModelCatalogEntry } from '../../../../services/chat/common/modelCatalog.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { renderMarkdown, type IRenderedMarkdown } from '../../../../../base/browser/markdownRenderer.js';
import { getHoverDelegate } from '../../../../../base/browser/ui/hover/hoverDelegate.js';
import type { IAction } from '../../../../../base/common/actions.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { ILanguageModelsService } from '../../common/languageModels.js';
import { getModelConfigValueLabel } from '../widget/input/modelPicker/modelPickerModelConfig.js';
import {
	ChatModelsViewModel, getManageModelsProviderLabel, isStatusEntry, SEARCH_SUGGESTIONS,
	type ILanguageModel, type ILanguageModelEntry, type IStatusEntry,
} from './chatModelsViewModel.js';
import './media/chatModelsWidget.css';

interface ModelRow {
	entry: ILanguageModelEntry;
	readonly element: HTMLElement;
	readonly name: HTMLElement;
	readonly toggle: Switch;
	readonly nameLabel: IconLabel;
	readonly content: HTMLElement;
	readonly contextButton: MutableDisposable<Button>;
	readonly details: HTMLElement;
	readonly commands: DisposableMap<string, Button>;
}

/** Formats only facts supplied by the selected catalog entry. */
export function getModelHoverContent(model: ILanguageModel): MarkdownString {
	const content = new MarkdownString();
	content.appendText(model.displayName);
	content.appendText(`\n${model.model.provider}/${model.model.model}\n${getManageModelsProviderLabel(model)}`);
	if (model.description) { content.appendText(`\n\n${model.description}`); }
	if (model.contextWindow) { content.appendText(`\n${localize('models.provider.contextTokens', '{0} tokens', model.contextWindow.toLocaleString())}`); }
	content.appendText(`\n\n${modelMetadata(model).join('\n')}`);
	return content;
}

/** Presentation of supplied facts only; prices retain their tier, interval and rate-card evidence. */
function modelMetadata(model: ILanguageModel): string[] {
	const support = (value: 'supported' | 'unsupported' | 'unknown' | undefined): string => value === 'supported'
		? localize('models.metadata.supported', 'Supported') : value === 'unsupported'
			? localize('models.metadata.unsupported', 'Not supported') : localize('models.metadata.unknown', 'Unknown');
	const lines = [localize('models.metadata.capabilities', 'Tools: {0}; Agent mode: {1}', support(model.capabilities?.toolCalling), support(model.capabilities?.agentMode))];
	if (model.usableContextWindow != null) {
		lines.push(localize('models.metadata.availableInput', 'Usable context: {0} input tokens', model.usableContextWindow.toLocaleString()));
	}
	if (model.inputModalities?.includes('image')) {
		lines.push(localize('models.metadata.vision', 'Image input'));
	}
	if (model.source) {
		const labels = {
			providerLive: localize('models.metadata.providerLive', 'Live provider catalog'),
			userConfigured: localize('models.metadata.userConfigured', 'User configuration'),
			builtinCurated: localize('models.metadata.builtinCurated', 'Bundled model catalog'),
			providerSeed: localize('models.metadata.providerSeed', 'Provider declaration'),
			persistedObservation: localize('models.metadata.persistedObservation', 'Saved provider observation'),
			unknown: localize('models.metadata.unknown', 'Unknown'),
		};
		lines.push(localize('models.metadata.source', 'Source: {0}; provider: {1}; connection: {2}', labels[model.source.metadata], model.source.providerId, model.source.connectionId));
	}
	if (!model.pricing?.length) { lines.push(localize('models.metadata.noPricing', 'Pricing unavailable for this connection.')); }
	for (const price of model.pricing ?? []) {
		const rates = [
			price.input != null ? localize('models.metadata.input', 'Input {0}', price.input) : undefined,
			price.output != null ? localize('models.metadata.output', 'Output {0}', price.output) : undefined,
			price.cacheRead != null ? localize('models.metadata.cacheRead', 'Cache read {0}', price.cacheRead) : undefined,
			price.cacheWrite != null ? localize('models.metadata.cacheWrite', 'Cache write {0}', price.cacheWrite) : undefined,
		].filter((value): value is string => value !== undefined).join('; ');
		const interval = price.maxInputTokens == null
			? localize('models.metadata.inputMinimum', 'Input tokens ≥ {0}', price.minInputTokens.toLocaleString())
			: localize('models.metadata.inputRange', '{0} ≤ input tokens < {1}', price.minInputTokens.toLocaleString(), price.maxInputTokens.toLocaleString());
		lines.push(localize('models.metadata.referencePricing', 'Reference prices ({0} per 1M tokens): {1}. Tier: {2}; region: {3}; {4}. Reviewed {5}; revision {6}.', price.currency, rates, price.serviceTier, price.region, interval, price.reviewedAt, price.revision));
	}
	lines.push(...new Set((model.pricing ?? []).flatMap(price => price.sourceUrls)));
	return lines;
}

/** A catalog projection for Models settings; visibility stays with the model service. */
export class ChatModelsWidget extends Disposable {
	public readonly element: HTMLElement;
	private readonly changed = this._register(new Emitter<number>());
	public readonly onDidChangeItemCount = this.changed.event;
	private readonly searchInput: InputBox;
	private readonly list: HTMLElement;
	private readonly message: HTMLElement;
	private readonly status: HTMLElement;
	private readonly viewModel: ChatModelsViewModel;
	private readonly resources = this._register(new DisposableMap<string, DisposableStore>());
	private rows: readonly ModelRow[] = [];
	private loading = false;
	private loaded = false;
	private count = 0;
	private operationPending = false;
	private readonly completions: HTMLElement;
	private completionValues: string[] = [];
	private completionIndex = -1;

	constructor(
		document: Document,
		private readonly host: {
			readonly matches?: (entry: ModelCatalogEntry) => boolean;
			readonly onStorageError?: (error: SecretStorageError) => void;
			readonly onConfigure?: (connection: string, model?: string) => Promise<void>;
		},
		@IInstantiationService instantiation: IInstantiationService,
		@INotificationService private readonly notifications: INotificationService,
		@IAccessibleViewService accessibleView: IAccessibleViewService,
		@IConfigurationService configuration: IConfigurationService,
		@ILanguageModelsService private readonly models: ILanguageModelsService,
		@IContextKeyService contextKeys: IContextKeyService,
	) {
		super();
		this.viewModel = this._register(instantiation.createInstance(ChatModelsViewModel));
		this.element = h(document, 'section');
		this.element.className = 'ash-chat-models-catalog';
		const scopedKeys = this._register(contextKeys.createScoped(this.element));
		const rowFocus = scopedKeys.createKey<boolean>('ashChatModelsRowFocus', false);
		this._register(addDisposableListener(this.element, 'focusin', event => { rowFocus.set(isHTMLElement(event.target) && !!event.target.closest('.ash-models-settings-model-row')); }));
		this._register(addDisposableListener(this.element, 'focusout', event => { if (!this.element.contains(event.relatedTarget as Node | null)) { rowFocus.set(false); } }));
		this.element.setAttribute('aria-label', localize('sessions.settings.chatModels', 'Chat models'));
		this.searchInput = this._register(new InputBox(this.element, {
			inputBoxStyles: defaultInputBoxStyles,
			type: 'search', presentation: 'field',
			ariaLabel: localize('models.catalog.search', 'Search models'),
			placeholder: localize('models.catalog.searchPlaceholder', 'Search model name or ID'),
		}));
		this.searchInput.inputElement.setAttribute('role', 'combobox');
		this.searchInput.inputElement.setAttribute('aria-autocomplete', 'list');
		this.completions = h(document, 'div');
		this.completions.className = 'ash-model-search-completions';
		this.completions.id = `model-search-${createUuid()}`;
		this.completions.setAttribute('role', 'listbox');
		this.completions.setAttribute('aria-label', localize('models.catalog.suggestions', 'Model search suggestions'));
		this.completions.hidden = true;
		this.element.append(this.completions);
		this._register(addDisposableListener(this.completions, 'mousedown', event => event.preventDefault()));
		this._register(addDisposableListener(this.completions, 'click', event => {
			const option = (event.target as HTMLElement).closest('[role="option"]');
			if (option) { this.acceptCompletion([...this.completions.children].indexOf(option)); }
		}));
		this.searchInput.inputElement.setAttribute('aria-controls', this.completions.id);
		this.searchInput.inputElement.setAttribute('aria-expanded', 'false');
		this._register(addDisposableListener(this.searchInput.inputElement, 'blur', () => this.hideCompletions()));
		this._register(addDisposableListener(this.searchInput.inputElement, 'keydown', event => {
			if (!this.completions.hidden && this.completionValues.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
				event.preventDefault(); event.stopPropagation();
				this.completionIndex = this.completionIndex < 0
					? event.key === 'ArrowDown' ? 0 : this.completionValues.length - 1
					: (this.completionIndex + (event.key === 'ArrowDown' ? 1 : -1) + this.completionValues.length) % this.completionValues.length;
				this.updateCompletionFocus();
				return;
			}
			if (!this.completions.hidden && event.key === 'Enter' && this.completionIndex >= 0) {
				event.preventDefault(); event.stopPropagation(); this.acceptCompletion(this.completionIndex); return;
			}
			if (!this.completions.hidden && event.key === 'Escape') {
				event.preventDefault(); event.stopPropagation(); this.hideCompletions(); return;
			}
			if (event.key === 'Escape' && this.searchInput.value) {
				event.preventDefault();
				event.stopPropagation();
				this.clearSearch();
			}
		}));
		this.list = h(document, 'div');
		this.list.className = 'ash-chat-models-list';
		this.message = h(document, 'p');
		this.message.className = 'ash-models-settings-empty';
		this.message.setAttribute('role', 'status');
		this.message.textContent = localize('sessions.settings.modelsLoading', 'Loading models…');
		this.status = h(document, 'p');
		this.status.className = 'ash-models-settings-status';
		this.status.setAttribute('role', 'alert');
		this.status.hidden = true;
		this.element.append(this.status, this.list, this.message);
		this._register(this.searchInput.onDidChange(value => {
			this.viewModel.filter(value);
			this.updateCompletions();
		}));
		this._register(this.viewModel.onDidChange(() => {
			if (this.element.hidden) { return; }
			this.updateRows();
			this.fireItemCount();
		}));
		const updateHint = (): void => {
			const hint = accessibleView.getOpenAriaHint(AccessibilityVerbositySettingId.ChatModelConfiguration);
			if (hint) { this.searchInput.inputElement.setAttribute('aria-description', hint); }
			else { this.searchInput.inputElement.removeAttribute('aria-description'); }
		};
		updateHint();
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(AccessibilityVerbositySettingId.ChatModelConfiguration)) { updateHint(); }
		}));
		for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
			this._register(AccessibleViewRegistry.register({
				type, priority: 110, name: `chat-models-${type}-${createUuid()}`,
				getProvider: () => {
					const focused = document.activeElement;
					if (this.element.hidden || !this.element.isConnected || !isHTMLElement(focused) || !this.element.contains(focused)) { return undefined; }
					return new AccessibleContentProvider(AccessibleViewProviderId.ChatModelConfiguration, { type },
						() => type === AccessibleViewType.Help
							? localize('models.catalog.managementHelp', 'The Model list card contains all models. Enabled models appear first; enabled and disabled models each keep the catalog order. Search matches names and IDs, including word prefixes and camel-case initials. Use @provider: followed by a connection ID or quoted provider name to filter providers, and @capability:vision, @capability:tools or @capability:agent to require explicitly supported capabilities. Type @ for suggestions; use Up and Down then Enter to insert a filter. Escape dismisses suggestions before clearing the search. Model switches control individual picker visibility; Space toggles the focused switch. Models that support context switching show a capacity text button beside their name. It shows the usable input capacity after output and safety reservations, independently of the compaction threshold. Context size saves automatically for this model. Use Enter or Space to switch between default and extended context; the value updates after saving. Use Tab to reach the controls. Configure model reveals the custom model editor. The separate Subscription accounts card manages account sign-in. The API access card manages credentials and custom endpoints. Hover a model switch or focus it and use <keybinding:workbench.action.showHover> for its full description, capabilities, source and reference prices; Accessible View also includes this information. Tool calling and Agent mode are independent; unknown is not unsupported. Reference prices retain currency, tier, region, input interval and review date; they do not describe subscription bills. Use Tab and Shift+Tab to move between controls. The API key section configures provider credentials and custom models.')
							: this.accessibleContent(),
						() => { if (focused.isConnected) { focused.focus(); } else { this.focusSearch(); } },
						AccessibilityVerbositySettingId.ChatModelConfiguration);
				},
			}));
		}
		this._register(toDisposable(() => { this.element.remove(); }));
	}

	public get itemCount(): number { return this.count; }
	/** Provider status rows also count as results for the surrounding Settings search. */
	public get hasResults(): boolean { return this.list.childElementCount > 0; }
	public focusSearch(): void { this.searchInput.focus(); }
	public search(filter: string, options: { readonly focus?: boolean; } = {}): void { if (options.focus !== false) { this.focusSearch(); } this.searchInput.value = filter; }
	public clearSearch(): void { this.search(''); }

	private fireItemCount(): void { this.changed.fire(this.itemCount); }

	public render(): void {
		if (this.viewModel.shouldRefilter()) { this.viewModel.filter(this.searchInput.value); }
		this.updateRows();
		if (!this.loaded && !this.loading) { void this.load(); }
	}

	private accessibleContent(): string {
		return [...this.list.children].map(element => {
			const row = this.rows.find(row => row.element === element);
			if (!row) {
				return element.textContent ?? '';
			}
			const model = row.entry.model;
			return `${model.displayName}, ${model.model.provider}/${model.model.model}, ${model.hidden ? localize('models.provider.disabled', 'Disabled') : localize('models.provider.enabled', 'Enabled')}, ${modelMetadata(model).join(', ')}`;
		}).join('\n') || this.message.textContent || '';
	}


	private async load(): Promise<void> {
		this.loading = true;
		try {
			await this.viewModel.refresh();
			this.loaded = true;
		} catch (error) {
			if (this.isDisposed || this.element.hidden) { return; }
			if (error instanceof SecretStorageError && this.host.onStorageError) { this.host.onStorageError(error); }
			else { this.notifications.error(localize('sessions.settings.modelsLoadFailed', 'Could not load models.')); }
		} finally {
			this.loading = false;
			if (!this.isDisposed && !this.element.hidden) { this.updateRows(); this.fireItemCount(); }
		}
	}

	private updateRows(): void {
		const entries = this.viewModel.viewModelEntries;
		const previous = new Map(this.rows.map(row => [row.entry.id, row]));
		const modelEntries = entries.filter((entry): entry is ILanguageModelEntry => entry.type === 'model');
		const ids = new Set(entries.map(entry => entry.id));
		for (const [id] of this.resources) {
			if (!ids.has(id)) { this.resources.deleteAndDispose(id); }
		}
		this.rows = modelEntries.map(entry => {
			const row = previous.get(entry.id) ?? this.createRow(entry, entry.id);
			row.entry = entry;
			row.nameLabel.setLabel(entry.model.displayName, undefined, { matches: entry.modelNameMatches });
			const actions = this.modelActions(entry.model);
			const restoreFocus = actions.length === 0 && row.details.contains(row.element.ownerDocument.activeElement);
			row.details.hidden = actions.length === 0;
			this.updateModelOptions(row, actions);
			if (restoreFocus) { row.toggle.focus(); }
			row.toggle.enabled = !this.operationPending;
			row.element.title = entry.model.displayName;
			row.toggle.input.setAttribute('aria-label', localize('sessions.settings.modelVisibility', 'Show {0} in model picker', entry.model.displayName));
			row.toggle.checked = !entry.model.hidden;
			return row;
		});
		const shown = this.rows.filter(row => this.host.matches?.(row.entry.model) ?? true)
			.sort((a, b) => Number(a.entry.model.hidden) - Number(b.entry.model.hidden));
		const desired = shown.map(row => row.element);
		const focused = this.element.ownerDocument.activeElement;
		for (const child of [...this.list.children]) { if (!desired.includes(child as HTMLElement)) { child.remove(); } }
		for (const [index, node] of desired.entries()) {
			if (this.list.children[index] !== node) { this.list.insertBefore(node, this.list.children[index] ?? null); }
		}
		if (isHTMLElement(focused) && this.list.contains(focused) && focused.ownerDocument.activeElement === focused.ownerDocument.body) { focused.focus(); }
		this.count = shown.length;
		const failure = entries.find((entry): entry is IStatusEntry => isStatusEntry(entry) && !entry.provider);
		this.message.hidden = !failure && (shown.length > 0 || desired.length > 0);
		this.message.setAttribute('role', failure ? 'alert' : 'status');
		this.message.textContent = failure?.message ?? (this.loaded
			? this.viewModel.getConfiguredVendors().length ? localize('models.catalog.noMatches', 'No models found.') : localize('sessions.settings.noModels', 'No models available.')
			: localize('sessions.settings.modelsLoading', 'Loading models…'));
	}

	private async runOperation(operation: () => Promise<void>, failureMessage = localize('models.catalog.savePreferencesFailed', 'Could not save model preferences.')): Promise<void> {
		if (this.operationPending) { return; }
		const focused = this.element.ownerDocument.activeElement;
		this.operationPending = true;
		this.status.hidden = true;
		this.updateRows();
		try { await operation(); }
		catch { if (!this.isDisposed) { this.reportWriteError(failureMessage); } }
		finally {
			if (!this.isDisposed) {
				this.operationPending = false;
				this.updateRows();
				if (isHTMLElement(focused) && this.element.contains(focused) && this.element.ownerDocument.activeElement === this.element.ownerDocument.body) { focused.focus(); }
			}
		}
	}

	private hideCompletions(): void {
		this.completions.hidden = true;
		this.searchInput.inputElement.setAttribute('aria-expanded', 'false');
		this.searchInput.inputElement.removeAttribute('aria-activedescendant');
		this.completionIndex = -1;
	}

	private updateCompletions(): void {
		const token = /(?:^|\s)(@[^\s]*)$/u.exec(this.searchInput.value)?.[1];
		if (!token || this.element.ownerDocument.activeElement !== this.searchInput.inputElement) { this.hideCompletions(); return; }
		const normalizedToken = token.replaceAll('"', '').toLowerCase();
		this.completionValues = [...SEARCH_SUGGESTIONS.CAPABILITIES, ...this.viewModel.getVendors().map(vendor => `@provider:"${vendor.vendor}"`)].filter(value => {
			const normalized = value.replaceAll('"', '').toLowerCase();
			return normalized.startsWith(normalizedToken) && normalized !== normalizedToken;
		});
		this.searchInput.inputElement.removeAttribute('aria-activedescendant');
		this.completions.replaceChildren();
		for (const [index, value] of this.completionValues.entries()) {
			const option = h(this.element.ownerDocument, 'div');
			option.id = `${this.completions.id}-${index}`;
			option.setAttribute('role', 'option');
			option.textContent = value;
			this.completions.append(option);
		}
		this.completionIndex = -1;
		this.completions.hidden = this.completionValues.length === 0;
		this.searchInput.inputElement.setAttribute('aria-expanded', String(!this.completions.hidden));
	}

	private updateCompletionFocus(): void {
		for (const [index, option] of [...this.completions.children].entries()) {
			option.classList.toggle('active', index === this.completionIndex);
			option.setAttribute('aria-selected', String(index === this.completionIndex));
		}
		this.searchInput.inputElement.setAttribute('aria-activedescendant', `${this.completions.id}-${this.completionIndex}`);
		const active = this.completions.children[this.completionIndex] as HTMLElement;
		const top = active.offsetTop - this.completions.offsetTop;
		this.completions.scrollTop = Math.max(top + active.offsetHeight - this.completions.clientHeight, Math.min(top, this.completions.scrollTop));
	}

	private acceptCompletion(index: number): void {
		const value = this.completionValues[index];
		if (value) { this.search(this.searchInput.value.replace(/@[^\s]*$/u, () => value)); }
		this.hideCompletions();
	}

	private reportWriteError(message = localize('sessions.settings.modelSaveFailed', 'Could not save model visibility.')): void {
		if (this.isDisposed || this.element.hidden) { return; }
		this.status.textContent = message;
		this.status.hidden = false;
		this.notifications.error(this.status.textContent);
	}

	private menuAction(id: string, label: string, run: () => unknown): IAction {
		return { id, label, tooltip: '', enabled: !this.operationPending, run };
	}

	private modelActions(model: ILanguageModel): IAction[] {
		const actions: IAction[] = [];
		const connection = model.source?.connectionId ?? model.provider.vendor.connection ?? model.model.provider;
		if (this.host.onConfigure && connection.startsWith('custom-')) {
			actions.push(this.menuAction('configureModel', localize('models.catalog.configureModel', 'Configure model'), () => this.runOperation(() => this.host.onConfigure!(connection, model.model.model))));
		}
		return actions;
	}

	private updateContextButton(row: ModelRow): void {
		const model = row.entry.model;
		const available = model.usableContextWindow;
		if (model.longContext === null || available == null) {
			const restoreFocus = row.contextButton.value?.hasFocus();
			row.contextButton.clear();
			if (restoreFocus) { row.toggle.focus(); }
			return;
		}
		let button = row.contextButton.value;
		if (!button) {
			button = new Button(row.content, {
				...defaultButtonStyles, label: '', presentation: 'quiet', size: 'small',
				onClick: () => {
					void this.runOperation(() => this.models.setModelPreferences(row.entry.model.model, { longContext: !row.entry.model.longContext }));
				},
			});
			button.domNode.classList.add('ash-model-context-button');
			const values = h(row.element.ownerDocument, 'span');
			values.className = 'ash-model-context-values';
			values.setAttribute('aria-hidden', 'true');
			for (const mode of ['default', 'extended']) {
				const value = h(row.element.ownerDocument, 'span');
				value.className = `ash-model-context-${mode}`;
				values.append(value);
			}
			button.domNode.append(values);
			row.contextButton.value = button;
		}
		// Both faces reserve the same space; only confirmed catalog values enter the flip.
		button.domNode.querySelector(model.longContext ? '.ash-model-context-extended' : '.ash-model-context-default')!.textContent = getModelConfigValueLabel(available);
		button.checked = model.longContext;
		button.enabled = !this.operationPending;
		button.domNode.setAttribute('aria-label', localize('models.catalog.contextButtonFor', 'Context size for {0}', model.displayName));
		const description = model.longContext
			? localize('models.catalog.contextButtonDefault', '{0} input tokens available under the current budget. Switch to default context.', available.toLocaleString())
			: localize('models.catalog.contextButtonExtended', '{0} input tokens available under the current budget. Switch to extended context.', available.toLocaleString());
		button.domNode.setAttribute('aria-description', description);
		button.setTitle(description);
	}

	private updateModelOptions(row: ModelRow, actions: readonly IAction[]): void {
		this.updateContextButton(row);
		const ids = new Set(actions.map(action => action.id));
		for (const [id] of row.commands) { if (!ids.has(id)) { row.commands.deleteAndDispose(id); } }
		for (const action of actions) {
			let button = row.commands.get(action.id);
			if (!button) {
				button = new Button(row.details, {
					...defaultButtonStyles, label: action.label, presentation: 'secondary', onClick: () => {
						void this.modelActions(row.entry.model).find(current => current.id === action.id)?.run();
					}
				});
				row.commands.set(action.id, button);
			}
			button.enabled = !this.operationPending;
		}
	}

	private createRow(entry: ILanguageModelEntry, id: string): ModelRow {
		const resources = new DisposableStore();
		this.resources.set(id, resources);
		const document = this.element.ownerDocument;
		const element = h(document, 'div');
		element.className = 'ash-models-settings-model-row ash-model-context-inline';
		element.title = entry.model.displayName;
		const copy = h(document, 'span');
		copy.className = 'ash-models-settings-model-copy';
		const name = h(document, 'span');
		const nameLabel = resources.add(new IconLabel(name, { label: entry.model.displayName }));
		copy.append(name);
		const content = h(document, 'div');
		content.className = 'ash-models-settings-model-content';
		content.append(copy);
		element.append(content);
		const toggle = resources.add(new Switch(element, {
			...defaultToggleStyles,
			ariaLabel: localize('sessions.settings.modelVisibility', 'Show {0} in model picker', entry.model.displayName),
			checked: !entry.model.hidden,
		}));
		const details = h(document, 'div');
		details.className = 'ash-model-details';
		details.id = `model-settings-${createUuid()}`;
		details.hidden = true;
		element.append(details);
		const row: ModelRow = {
			entry, element, name, nameLabel, toggle, content, details,
			contextButton: resources.add(new MutableDisposable<Button>()),
			commands: resources.add(new DisposableMap<string, Button>()),
		};
		const hoverContent = resources.add(new MutableDisposable<IRenderedMarkdown>());
		// Native switches own Space; the hover's focus listeners already expose the description.
		resources.add(getHoverDelegate().setupDelayedHover(toggle.input, () => {
			const rendered = renderMarkdown(getModelHoverContent(row.entry.model), { ownerDocument: document });
			hoverContent.value = rendered;
			return { content: rendered.element };
		}));
		resources.add(addDisposableListener(toggle.input, 'focus', () => { this.viewModel.selectedEntry = row.entry; }));
		resources.add(toggle.onDidChange(() => {
			const focused = element.contains(document.activeElement);
			toggle.busy = true;
			this.status.hidden = true;
			void this.viewModel.toggleModelHidden(row.entry).catch(() => {
				if (this.isDisposed || resources.isDisposed) { return; }
				this.reportWriteError();
			}).finally(() => {
				if (this.isDisposed || resources.isDisposed) { return; }
				toggle.busy = false;
				this.updateRows();
				if (focused && !this.element.hidden && element.isConnected && document.activeElement === document.body) { toggle.focus(); }
			});
		}));
		return row;
	}
}
