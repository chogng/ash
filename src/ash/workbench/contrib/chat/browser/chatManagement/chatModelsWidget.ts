import { addDisposableListener, h, isHTMLElement } from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { IconLabel } from '../../../../../base/browser/ui/iconlabel/iconlabel.js';
import { InputBox } from '../../../../../base/browser/ui/inputbox/inputbox.js';
import { Checkbox, Switch } from '../../../../../base/browser/ui/toggle/toggle.js';
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
import { defaultButtonStyles, defaultInputBoxStyles, defaultToggleStyles, defaultCheckboxStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import type { ModelCatalogEntry } from '../../../../services/chat/common/modelCatalog.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { renderMarkdown, type IRenderedMarkdown } from '../../../../../base/browser/markdownRenderer.js';
import { getHoverDelegate } from '../../../../../base/browser/ui/hover/hoverDelegate.js';
import { Separator, SubmenuAction, type IAction } from '../../../../../base/common/actions.js';
import type { ContextMenuAnchor } from '../../../../../base/browser/contextmenu.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { ILanguageModelsService } from '../../common/languageModels.js';
import { modelPickerAccelerationOptions, getModelConfigValueLabel } from '../widget/input/modelPicker/modelPickerModelConfig.js';
import {
	ChatModelsViewModel, getManageModelsProviderLabel, isLanguageModelProviderEntry, isStatusEntry, SEARCH_SUGGESTIONS,
	type ILanguageModel, type ILanguageModelEntry, type ILanguageModelProviderEntry, type IStatusEntry, type IViewModelEntry,
} from './chatModelsViewModel.js';
import './media/chatModelsWidget.css';

interface ModelRow {
	entry: ILanguageModelEntry;
	readonly element: HTMLElement;
	readonly name: HTMLElement;
	readonly toggle: Switch;
	readonly select: Checkbox;
	readonly nameLabel: IconLabel;
	readonly menu: Button;
}

interface ProviderRow {
	entry: ILanguageModelProviderEntry;
	readonly element: HTMLElement;
	readonly expand: Button;
	readonly toggle: Switch;
	readonly menu: Button;
	readonly progress: HTMLElement;
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
	private readonly expandRow: HTMLElement;
	private readonly expandButton: Button;
	private readonly viewModel: ChatModelsViewModel;
	private readonly collapse: Button;
	private readonly suggestions: HTMLDetailsElement;
	private readonly filterActions: HTMLElement;
	private readonly filterResources = this._register(new DisposableMap<string, DisposableStore>());
	private readonly filterButtons = new Map<string, Button>();
	private readonly providerRows = new Map<string, ProviderRow>();
	private readonly statusRows = new Map<string, HTMLElement>();
	private readonly resources = this._register(new DisposableMap<string, DisposableStore>());
	private rows: readonly ModelRow[] = [];
	private expanded = false;
	private loading = false;
	private loaded = false;
	private count = 0;
	private readonly selection = new Set<string>();
	private selectionAnchor: string | undefined;
	private readonly selectionActions: HTMLElement;
	private readonly selectionCount: HTMLElement;
	private readonly selectionButtons: Button[] = [];
	private readonly selectAll: Button;
	private operationPending = false;
	private refreshingConnection: string | undefined;
	private readonly completions: HTMLElement;
	private completionValues: string[] = [];
	private completionIndex = -1;

	constructor(
		document: Document,
		private readonly host: {
			readonly compact?: boolean;
			readonly matches?: (entry: ModelCatalogEntry) => boolean;
			readonly matchesProvider?: (connection: string, label: string) => boolean;
			readonly isFiltering?: () => boolean;
			readonly onStorageError?: (error: SecretStorageError) => void;
			readonly onConfigure?: (connection: string, model?: string) => Promise<void>;
		},
		@IInstantiationService instantiation: IInstantiationService,
		@INotificationService private readonly notifications: INotificationService,
		@IAccessibleViewService accessibleView: IAccessibleViewService,
		@IConfigurationService configuration: IConfigurationService,
		@IContextMenuService private readonly contextMenus: IContextMenuService,
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
		this.collapse = this._register(new Button(this.element, {
			...defaultButtonStyles, presentation: 'secondary',
			label: localize('models.catalog.collapseAll', 'Collapse All'),
		}));
		this.collapse.domNode.hidden = this.host.compact === true;
		this._register(this.collapse.onDidClick(() => this.viewModel.collapseAll()));
		this.suggestions = h(document, 'details');
		this.suggestions.className = 'ash-chat-models-filters';
		this.suggestions.hidden = this.host.compact === true;
		const filterSummary = h(document, 'summary');
		filterSummary.textContent = localize('models.catalog.filters', 'Search filters');
		filterSummary.title = localize('models.catalog.filterHint', 'Filters: {0}', SEARCH_SUGGESTIONS.FILTER_TYPES.join(', '));
		this.filterActions = h(document, 'div');
		this.filterActions.className = 'ash-chat-models-filter-actions';
		this.suggestions.append(filterSummary, this.filterActions);
		this.element.insertBefore(this.suggestions, this.collapse.domNode);
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
		this.expandRow = h(document, 'div');
		this.expandRow.className = 'ash-models-settings-expand';
		this.expandButton = this._register(new Button(this.expandRow, {
			...defaultButtonStyles,
			label: localize('models.catalog.viewAll', 'viewall models'),
			icon: Lxicon.chevronDown, presentation: 'secondary',
		}));
		this.expandButton.domNode.setAttribute('aria-expanded', 'false');
		this.selectionActions = h(document, 'div');
		this.selectionActions.className = 'ash-chat-models-selection-actions';
		this.selectionActions.setAttribute('role', 'group');
		this.selectionActions.setAttribute('aria-label', localize('models.catalog.selectionActions', 'Selected model actions'));
		this.selectionCount = h(document, 'span');
		this.selectionCount.setAttribute('role', 'status');
		this.selectionActions.append(this.selectionCount);
		const actions = [
			{ label: localize('models.catalog.showSelected', 'Show selected'), run: () => this.runSelection(entries => this.viewModel.setModelsHidden(entries, false)) },
			{ label: localize('models.catalog.hideSelected', 'Hide selected'), run: () => this.runSelection(entries => this.viewModel.setModelsHidden(entries, true)) },
			{ label: localize('models.catalog.clearSelection', 'Clear selection'), run: () => { this.selection.clear(); this.updateRows(); } },
		];
		for (const action of actions) {
			const button = this._register(new Button(this.selectionActions, { ...defaultButtonStyles, label: action.label, presentation: 'quiet' }));
			this._register(button.onDidClick(action.run));
			this.selectionButtons.push(button);
		}
		this.selectAll = this._register(new Button(this.selectionActions, { ...defaultButtonStyles, label: localize('models.catalog.selectAll', 'Select all results'), presentation: 'quiet' }));
		this._register(this.selectAll.onDidClick(() => { for (const row of this.visibleRows()) { this.selection.add(row.entry.id); } this.updateRows(); }));
		this.element.append(this.status, this.selectionActions, this.list, this.message, this.expandRow);
		this._register(this.expandButton.onDidClick(() => {
			this.expanded = !this.expanded;
			// Overview rows must remain available after a provider was collapsed in the full list.
			if (!this.expanded) { this.viewModel.expandAll(); }
			this.updateRows();
			this.changed.fire(this.count);
		}));
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
							? this.host.compact && !this.expanded ? localize('models.catalog.help', 'Models shows the newest model from each provider. Enabled models appear first; each group keeps the catalog order. Turning a model off restores its place among disabled models. Search models filters the full list by model name or provider/model ID. Escape clears the search and restores the list. Use viewall models to show the full catalog with provider groups, provider switches and Search filters, or return to the overview. Use Tab and Shift+Tab to move between search, model switches, and buttons. Space toggles whether a model appears in the chat picker. The API key section in Models settings configures provider credentials and custom models.')
								: localize('models.catalog.managementHelp', 'Models settings lists models by provider. Search matches names and IDs, including word prefixes and camel-case initials. Use @provider: followed by a connection ID or quoted provider name to filter providers, and @capability:vision, @capability:tools or @capability:agent to require explicitly supported capabilities. Search filters offers buttons that insert supported filters. Type @ for suggestions; use Up and Down then Enter to insert a filter. Escape dismisses suggestions before clearing the search. Enter or Space on a provider button expands or collapses its models; Collapse All closes all groups. A provider switch changes all models of that connection, including models outside the current search. Model switches control individual picker visibility. Select model checkboxes for Show selected or Hide selected. Shift-click selects a range; Up, Down, Home and End move between selection checkboxes. Select all results selects the visible rows. Within a model row, Ctrl+A or Command+A selects all visible models; Shift+Up and Shift+Down extend a range. The search input keeps its text-selection shortcuts. Row action buttons and right-click open menus for the current selection; Shift+F10 opens the focused model menu. Context size and Speed menus update only this model’s supported preferences. Configure model and Configure provider reveal the existing settings, or open account management for subscription connections. Provider menus offer Refresh models and preserve known models if discovery fails. Clear selection returns focus to Select all results. Hover a model switch or focus it and use <keybinding:workbench.action.showHover> for its full description, capabilities, source and reference prices; Accessible View also includes this information. Tool calling and Agent mode are independent; unknown is not unsupported. Reference prices retain currency, tier, region, input interval and review date; they do not describe subscription bills. Use viewall models to return to the overview. Use Tab and Shift+Tab to move between controls. The API key section configures provider credentials and custom models.')
							: this.accessibleContent(),
						() => { if (focused.isConnected) { focused.focus(); } else { this.focusSearch(); } },
						AccessibilityVerbositySettingId.ChatModelConfiguration);
				},
			}));
		}
		this._register(toDisposable(() => { this.element.remove(); }));
	}

	public get itemCount(): number { return this.count; }
	/** Collapsed matching providers still count as results for the surrounding Settings search. */
	public get hasResults(): boolean { return this.list.childElementCount > 0; }
	public focusSearch(): void { this.searchInput.focus(); }
	public search(filter: string, options: { readonly focus?: boolean; } = {}): void { if (options.focus !== false) { this.focusSearch(); } this.searchInput.value = filter; }
	public clearSearch(): void { this.search(''); }

	private fireItemCount(): void { this.changed.fire(this.itemCount); }

	public render(options: { readonly expandGroups?: boolean; } = {}): void {
		if (options.expandGroups) { this.viewModel.expandAll(); }
		if (this.viewModel.shouldRefilter()) { this.viewModel.filter(this.searchInput.value); }
		this.updateRows();
		if (!this.loaded && !this.loading) { void this.load(); }
	}

	private accessibleContent(): string {
		return [...this.list.children].map(element => {
			const row = this.rows.find(row => row.element === element);
			if (!row) { return element.textContent ?? ''; }
			if (this.host.compact && !this.expanded) { return row.entry.model.displayName; }
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
		const statusOnly = !entries.some(entry => entry.type === 'model') && entries.some(entry => isLanguageModelProviderEntry(entry) && entry.vendorEntry.vendor.catalog);
		const grouped = !this.host.compact || this.expanded || statusOnly;
		this.element.classList.toggle('is-grouped', grouped);
		this.collapse.domNode.hidden = !grouped;
		this.suggestions.hidden = !grouped;
		const previous = new Map(this.rows.map(row => [row.entry.id, row]));
		const modelEntries = entries.filter((entry): entry is ILanguageModelEntry => entry.type === 'model');
		const ids = new Set(entries.map(entry => entry.id));
		for (const [id] of this.statusRows) { if (!ids.has(id)) { this.statusRows.delete(id); } }
		for (const [id] of this.resources) {
			if (!ids.has(id)) { this.resources.deleteAndDispose(id); this.providerRows.delete(id); this.statusRows.delete(id); }
		}
		this.rows = modelEntries.map(entry => {
			const row = previous.get(entry.id) ?? this.createRow(entry, entry.id);
			row.entry = entry;
			row.nameLabel.setLabel(entry.model.displayName, undefined, { matches: entry.modelNameMatches });
			row.select.input.setAttribute('aria-label', localize('models.catalog.selectModel', 'Select {0}', entry.model.displayName));
			row.select.element.hidden = !grouped;
			row.menu.domNode.hidden = !grouped;
			row.menu.enabled = !this.operationPending;
			row.select.enabled = !this.operationPending;
			row.toggle.enabled = !this.operationPending;
			row.element.title = entry.model.displayName;
			row.toggle.input.setAttribute('aria-label', localize('sessions.settings.modelVisibility', 'Show {0} in model picker', entry.model.displayName));
			row.toggle.checked = !entry.model.hidden;
			return row;
		});
		const filtering = !!this.searchInput.value.trim() || this.host.isFiltering?.() === true;
		const providers = new Set<string>();
		let shown = this.rows.filter(row => {
			const model = row.entry.model;
			const first = !providers.has(model.model.provider);
			providers.add(model.model.provider);
			return (!this.host.compact || this.expanded || filtering || first) && (this.host.matches?.(model) ?? true);
		});
		if (this.host.compact) { shown = shown.sort((a, b) => Number(a.entry.model.hidden) - Number(b.entry.model.hidden)); }
		const desired: HTMLElement[] = [];
		if (!grouped) { desired.push(...shown.map(row => row.element)); }
		else {
			for (const entry of entries) {
				if (isLanguageModelProviderEntry(entry)) {
					const groupRows = shown.filter(row => row.entry.model.model.provider === entry.vendorEntry.group.vendor);
					const hasHostMatch = this.viewModel.getModelsForGroup(entry).some(model => this.host.matches?.(model) ?? true);
					const status = entries.find((candidate): candidate is IStatusEntry => isStatusEntry(candidate) && candidate.provider === entry.vendorEntry.group.vendor);
					const providerMatches = this.host.matchesProvider?.(entry.vendorEntry.vendor.connection ?? entry.vendorEntry.group.vendor, entry.label) ?? true;
					if (groupRows.length || entry.collapsed && hasHostMatch || providerMatches && (status || entry.collapsed && entry.vendorEntry.vendor.catalog)) {
						desired.push(this.providerRow(entry));
						if (status) {
							let node = this.statusRows.get(status.id);
							if (!node) { node = h(this.element.ownerDocument, 'p'); node.className = 'ash-models-catalog-connection-status'; node.setAttribute('role', 'status'); this.statusRows.set(status.id, node); }
							node.textContent = status.message;
							desired.push(node);
						}
						desired.push(...groupRows.map(row => row.element));
					}
				}
			}
		}
		const focused = this.element.ownerDocument.activeElement;
		for (const child of [...this.list.children]) { if (!desired.includes(child as HTMLElement)) { child.remove(); } }
		for (const [index, node] of desired.entries()) {
			if (this.list.children[index] !== node) { this.list.insertBefore(node, this.list.children[index] ?? null); }
		}
		if (isHTMLElement(focused) && this.list.contains(focused) && focused.ownerDocument.activeElement === focused.ownerDocument.body) { focused.focus(); }
		if (!grouped) { this.selection.clear(); }
		const visibleIds = new Set(this.visibleRows().map(row => row.entry.id));
		for (const id of this.selection) { if (!visibleIds.has(id)) { this.selection.delete(id); } }
		if (this.selectionAnchor && !visibleIds.has(this.selectionAnchor)) { this.selectionAnchor = undefined; }
		for (const row of this.rows) { row.select.checked = this.selection.has(row.entry.id); }
		this.selectionActions.hidden = !grouped;
		this.selectionCount.textContent = localize('models.catalog.selectedCount', '{0} models selected', this.selection.size);
		this.selectionCount.hidden = this.selection.size === 0;
		for (const button of this.selectionButtons) { button.enabled = this.selection.size > 0 && !this.operationPending; button.domNode.hidden = this.selection.size === 0; }
		if (!this.selection.size && this.selectionActions.contains(focused) && focused !== this.selectAll.domNode) { this.selectAll.focus(); }
		this.selectAll.enabled = shown.length > 0 && !this.operationPending;
		this.count = shown.length;
		const failure = entries.find((entry): entry is IStatusEntry => isStatusEntry(entry) && !entry.provider);
		this.message.hidden = !failure && (shown.length > 0 || desired.length > 0);
		this.message.setAttribute('role', failure ? 'alert' : 'status');
		this.message.textContent = failure?.message ?? (this.loaded
			? this.viewModel.getConfiguredVendors().length ? localize('models.catalog.noMatches', 'No models found.') : localize('sessions.settings.noModels', 'No models available.')
			: localize('sessions.settings.modelsLoading', 'Loading models…'));
		this.expandRow.hidden = !this.host.compact || !this.expanded && this.rows.length === 0;
		this.expandButton.domNode.setAttribute('aria-expanded', String(this.expanded));
		this.expandButton.icon = this.expanded ? Lxicon.chevronUp : Lxicon.chevronDown;
		this.collapse.enabled = entries.some(isLanguageModelProviderEntry);
		this.updateFilterSuggestions();
	}

	private visibleRows(): ModelRow[] {
		return [...this.list.children].flatMap(element => { const row = this.rows.find(row => row.element === element); return row ? [row] : []; });
	}

	private runSelection(operation: (entries: readonly ILanguageModelEntry[]) => Promise<void>): void {
		const entries = this.visibleRows().filter(row => this.selection.has(row.entry.id)).map(row => row.entry);
		if (entries.length) { void this.runOperation(() => operation(entries)); }
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

	private updateFilterSuggestions(): void {
		const options = [
			...SEARCH_SUGGESTIONS.CAPABILITIES.map(value => ({ value, label: value })),
			...this.viewModel.getVendors().map(vendor => ({ value: `@provider:"${vendor.vendor}"`, label: `@provider:${vendor.displayName}` })),
		];
		const ids = new Set(options.map(option => option.value));
		for (const [id] of this.filterResources) {
			if (!ids.has(id)) { this.filterResources.deleteAndDispose(id); this.filterButtons.delete(id); }
		}
		for (const [index, option] of options.entries()) {
			let button = this.filterButtons.get(option.value);
			if (!button) {
				const resources = new DisposableStore();
				this.filterResources.set(option.value, resources);
				button = resources.add(new Button(this.filterActions, { ...defaultButtonStyles, label: option.label, presentation: 'secondary' }));
				resources.add(button.onDidClick(() => {
					this.search(`${this.searchInput.value.trim()} ${option.value}`.trim());
					this.hideCompletions();
					this.suggestions.open = false;
				}));
				this.filterButtons.set(option.value, button);
			}
			button.label = option.label;
			if (this.filterActions.children[index] !== button.domNode) { this.filterActions.insertBefore(button.domNode, this.filterActions.children[index] ?? null); }
		}
	}

	private providerRow(entry: ILanguageModelProviderEntry): HTMLElement {
		let row = this.providerRows.get(entry.id);
		if (!row) {
			const resources = new DisposableStore();
			this.resources.set(entry.id, resources);
			const element = h(this.element.ownerDocument, 'div');
			element.className = 'ash-chat-models-provider';
			const expand = resources.add(new Button(element, { ...defaultButtonStyles, label: entry.label, presentation: 'quiet' }));
			const progress = h(this.element.ownerDocument, 'small');
			progress.setAttribute('role', 'status');
			progress.textContent = localize('models.catalog.refreshing', 'Refreshing models…');
			element.append(progress);
			const menu = resources.add(new Button(element, { ...defaultButtonStyles, label: localize('models.catalog.providerActions', 'Manage {0}', entry.label), icon: Lxicon.toolBarMore, iconOnly: true, presentation: 'quiet' }));
			menu.domNode.setAttribute('aria-haspopup', 'menu');
			const toggle = resources.add(new Switch(element, { ...defaultToggleStyles, checked: !entry.hidden, ariaLabel: localize('models.catalog.providerVisibility', 'Show {0} models in model picker', entry.label) }));
			row = { entry, element, expand, toggle, menu, progress };
			const current = row;
			resources.add(menu.onDidClick(() => this.showProviderMenu(current, menu.domNode)));
			resources.add(addDisposableListener(element, 'contextmenu', event => { event.preventDefault(); this.showProviderMenu(current, { x: event.clientX, y: event.clientY, targetWindow: element.ownerDocument.defaultView! }); }));
			resources.add(expand.onDidClick(() => this.viewModel.toggleCollapsed(current.entry)));
			resources.add(toggle.onDidChange(() => {
				const focused = element.contains(element.ownerDocument.activeElement);
				this.status.hidden = true;
				toggle.busy = true;
				void this.viewModel.toggleGroupHidden(current.entry).catch(() => this.reportWriteError()).finally(() => {
					if (resources.isDisposed) { return; }
					toggle.busy = false;
					this.updateRows();
					if (focused && !this.element.hidden && element.isConnected && element.ownerDocument.activeElement === element.ownerDocument.body) { toggle.focus(); }
				});
			}));
			this.providerRows.set(entry.id, row);
		}
		row.entry = entry;
		row.expand.label = entry.label;
		row.expand.icon = entry.collapsed ? Lxicon.chevronRight : Lxicon.chevronDown;
		row.expand.domNode.setAttribute('aria-expanded', String(!entry.collapsed));
		row.toggle.checked = !entry.hidden;
		row.toggle.enabled = !this.operationPending;
		row.toggle.enabled = row.toggle.enabled && this.viewModel.getModelsForGroup(entry).length > 0;
		row.menu.enabled = !this.operationPending;
		row.menu.label = localize('models.catalog.providerActions', 'Manage {0}', entry.label);
		const refreshing = this.refreshingConnection === (entry.vendorEntry.vendor.catalog?.connection ?? entry.vendorEntry.vendor.connection ?? entry.vendorEntry.vendor.vendor);
		row.progress.hidden = !refreshing;
		row.element.setAttribute('aria-busy', String(refreshing));
		row.toggle.input.setAttribute('aria-label', localize('models.catalog.providerVisibility', 'Show {0} models in model picker', entry.label));
		return row.element;
	}

	private reportWriteError(message = localize('sessions.settings.modelSaveFailed', 'Could not save model visibility.')): void {
		if (this.isDisposed || this.element.hidden) { return; }
		this.status.textContent = message;
		this.status.hidden = false;
		this.notifications.error(this.status.textContent);
	}

	private menuAction(id: string, label: string, run: () => unknown, checked?: boolean): IAction {
		return { id, label, tooltip: '', enabled: !this.operationPending, checked, run };
	}

	private configurationActions(model: ILanguageModel): IAction[] {
		const actions: IAction[] = [];
		if (model.longContext !== null) {
			actions.push(new SubmenuAction('context', localize('models.catalog.contextSize', 'Context size'), [false, true].map(longContext => {
				const tokens = longContext ? model.maximumContextWindow : model.defaultContextWindow;
				let label = longContext ? localize('models.catalog.longContext', 'Long context') : localize('models.catalog.defaultContext', 'Default context');
				if (tokens) { label = longContext ? getModelConfigValueLabel(tokens) : localize('chat.modelPicker.defaultContext', '{0} (Default)', getModelConfigValueLabel(tokens)); }
				return this.menuAction(`context.${longContext}`, label, () => this.runOperation(() => this.models.setModelPreferences(model.model, { longContext })), model.longContext === longContext);
			})));
		}
		const acceleration = modelPickerAccelerationOptions(model);
		if (acceleration.length) {
			actions.push(new SubmenuAction('acceleration', localize('models.catalog.speed', 'Speed'), acceleration.map(option => this.menuAction(`acceleration.${option.value ?? 'default'}`, option.label, () => this.runOperation(() => this.models.setModelPreferences(model.model, { acceleration: option.value })), option.checked))));
		}
		return actions;
	}

	private showModelMenu(row: ModelRow, anchor: ContextMenuAnchor): void {
		const focused = this.element.ownerDocument.activeElement;
		if (!this.selection.has(row.entry.id)) {
			this.selection.clear(); this.selection.add(row.entry.id); this.selectionAnchor = row.entry.id; this.updateRows();
		}
		const entries = this.visibleRows().filter(candidate => this.selection.has(candidate.entry.id)).map(candidate => candidate.entry);
		const hidden = entries.every(entry => entry.model.hidden);
		const actions: IAction[] = [
			this.menuAction('visibility', hidden ? localize('models.catalog.showSelected', 'Show selected') : localize('models.catalog.hideSelected', 'Hide selected'), () => this.runOperation(() => this.viewModel.setModelsHidden(entries, !hidden))),
		];
		if (entries.length === 1) {
			const model = entries[0].model;
			actions.push(...this.configurationActions(model));
			if (this.host.onConfigure) {
				const connection = model.source?.connectionId ?? model.provider.vendor.connection ?? model.model.provider;
				actions.push(new Separator());
				if (connection.startsWith('custom-')) {
					actions.push(this.menuAction('configureModel', localize('models.catalog.configureModel', 'Configure model'), () => this.runOperation(() => this.host.onConfigure!(connection, model.model.model))));
				}
				actions.push(this.menuAction('configureProvider', localize('models.catalog.configureProvider', 'Configure provider'), () => this.runOperation(() => this.host.onConfigure!(connection))));
			}
		}
		this.contextMenus.showContextMenu({
			getAnchor: () => anchor, getActions: () => actions, autoSelectFirstItem: true, onHide: cancelled => {
				if (cancelled || this.element.ownerDocument.activeElement === this.element.ownerDocument.body) {
					if (isHTMLElement(focused) && focused.isConnected) { focused.focus(); }
					else if (row.menu.domNode.isConnected) { row.menu.focus(); }
				}
			}
		});
	}

	private showProviderMenu(row: ProviderRow, anchor: ContextMenuAnchor): void {
		const focused = this.element.ownerDocument.activeElement;
		const vendor = row.entry.vendorEntry.vendor;
		const connection = vendor.catalog?.connection ?? vendor.connection ?? vendor.vendor;
		const actions: IAction[] = [];
		if (this.host.onConfigure) { actions.push(this.menuAction('configureProvider', localize('models.catalog.configureProvider', 'Configure provider'), () => this.runOperation(() => this.host.onConfigure!(connection)))); }
		if (!vendor.catalog?.issues.includes('discoveryUnsupported')) {
			actions.push(this.menuAction('refreshProvider', localize('models.provider.refresh', 'Refresh models'), () => this.refreshProvider(connection)));
		}
		if (this.viewModel.getModelsForGroup(row.entry).length) { actions.push(this.menuAction('providerVisibility', row.entry.hidden ? localize('models.catalog.showAll', 'Show all models') : localize('models.catalog.hideAll', 'Hide all models'), () => this.runOperation(() => this.viewModel.toggleGroupHidden(row.entry)))); }
		this.contextMenus.showContextMenu({
			getAnchor: () => anchor, getActions: () => actions, autoSelectFirstItem: true, onHide: cancelled => {
				if (cancelled || this.element.ownerDocument.activeElement === this.element.ownerDocument.body) {
					if (isHTMLElement(focused) && focused.isConnected) { focused.focus(); }
					else if (row.menu.domNode.isConnected) { row.menu.focus(); }
				}
			}
		});
	}

	private refreshProvider(connection: string): Promise<void> {
		return this.runOperation(async () => {
			this.refreshingConnection = connection;
			this.updateRows();
			try { await this.models.discoverProviderModels(connection); }
			finally {
				this.refreshingConnection = undefined;
				await this.viewModel.refresh();
			}
		}, localize('models.catalog.refreshError', 'Could not refresh models.'));
	}

	private createRow(entry: ILanguageModelEntry, id: string): ModelRow {
		const resources = new DisposableStore();
		this.resources.set(id, resources);
		const document = this.element.ownerDocument;
		const element = h(document, 'div');
		element.className = 'ash-models-settings-model-row';
		element.title = entry.model.displayName;
		const copy = h(document, 'span');
		copy.className = 'ash-models-settings-model-copy';
		const name = h(document, 'span');
		const nameLabel = resources.add(new IconLabel(name, { label: entry.model.displayName }));
		copy.append(name);
		const select = resources.add(new Checkbox(element, { ...defaultCheckboxStyles, ariaLabel: localize('models.catalog.selectModel', 'Select {0}', entry.model.displayName) }));
		const content = h(document, 'div');
		content.className = 'ash-models-settings-model-content';
		element.append(content);
		const toggle = resources.add(new Switch(content, {
			...defaultToggleStyles,
			ariaLabel: localize('sessions.settings.modelVisibility', 'Show {0} in model picker', entry.model.displayName),
			checked: !entry.model.hidden, content: copy, contentPlacement: 'before-control',
		}));
		const menu = resources.add(new Button(element, { ...defaultButtonStyles, label: localize('models.catalog.modelActions', 'Actions for {0}', entry.model.displayName), icon: Lxicon.toolBarMore, iconOnly: true, presentation: 'quiet' }));
		menu.domNode.setAttribute('aria-haspopup', 'menu');
		const row = { entry, element, name, nameLabel, select, toggle, menu };
		resources.add(menu.onDidClick(() => this.showModelMenu(row, menu.domNode)));
		resources.add(addDisposableListener(element, 'contextmenu', event => { event.preventDefault(); this.showModelMenu(row, { x: event.clientX, y: event.clientY, targetWindow: document.defaultView! }); }));
		resources.add(addDisposableListener(element, 'keydown', event => {
			if (event.key === 'F10' && event.shiftKey || event.key === 'ContextMenu') { event.preventDefault(); event.stopPropagation(); this.showModelMenu(row, menu.domNode); }
			if (event.key.toLowerCase() === 'a' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.stopPropagation(); for (const candidate of this.visibleRows()) { this.selection.add(candidate.entry.id); } this.updateRows(); }
		}));
		resources.add(addDisposableListener(select.input, 'click', event => {
			const visible = this.visibleRows();
			const current = visible.indexOf(row);
			const anchor = visible.findIndex(candidate => candidate.entry.id === this.selectionAnchor);
			const affected = event.shiftKey && anchor >= 0 ? visible.slice(Math.min(anchor, current), Math.max(anchor, current) + 1) : [row];
			for (const candidate of affected) { if (select.checked) { this.selection.add(candidate.entry.id); } else { this.selection.delete(candidate.entry.id); } }
			this.selectionAnchor = row.entry.id;
			this.updateRows();
		}));
		resources.add(addDisposableListener(select.input, 'keydown', event => {
			const visible = this.visibleRows();
			const current = visible.indexOf(row);
			const next = event.key === 'ArrowDown' ? current + 1 : event.key === 'ArrowUp' ? current - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? visible.length - 1 : undefined;
			if (next !== undefined) {
				event.preventDefault(); event.stopPropagation();
				const target = Math.max(0, Math.min(visible.length - 1, next));
				if (event.shiftKey) {
					if (!this.selectionAnchor) { this.selectionAnchor = row.entry.id; }
					const anchor = Math.max(0, visible.findIndex(candidate => candidate.entry.id === this.selectionAnchor));
					this.selection.clear();
					for (const candidate of visible.slice(Math.min(anchor, target), Math.max(anchor, target) + 1)) { this.selection.add(candidate.entry.id); }
					this.updateRows();
				} else { this.selectionAnchor = visible[target].entry.id; }
				visible[target]?.select.focus();
			}
		}));
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
