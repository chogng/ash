import { addDisposableListener, h, isHTMLElement } from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
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
import { ChatModelsViewModel, getManageModelsProviderLabel, isLanguageModelProviderEntry, isStatusEntry, SEARCH_SUGGESTIONS, type ILanguageModel, type ILanguageModelEntry, type ILanguageModelProviderEntry, type IViewModelEntry } from './chatModelsViewModel.js';
import './media/chatModelsWidget.css';

interface ModelRow {
	entry: ILanguageModelEntry;
	readonly element: HTMLElement;
	readonly name: HTMLElement;
	readonly toggle: Switch;
}

interface ProviderRow {
	entry: ILanguageModelProviderEntry;
	readonly element: HTMLElement;
	readonly expand: Button;
	readonly toggle: Switch;
}

/** Formats only facts supplied by the selected catalog entry. */
export function getModelHoverContent(model: ILanguageModel): MarkdownString {
	const content = new MarkdownString();
	content.appendText(model.displayName);
	content.appendText(`\n${model.model.provider}/${model.model.model}\n${getManageModelsProviderLabel(model)}`);
	if (model.description) { content.appendText(`\n\n${model.description}`); }
	if (model.contextWindow) { content.appendText(`\n${localize('models.provider.contextTokens', '{0} tokens', model.contextWindow.toLocaleString())}`); }
	return content;
}

/** A catalog projection shared by Settings and the models editor; visibility stays with the model service. */
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
	private readonly resources = this._register(new DisposableMap<string, DisposableStore>());
	private rows: readonly ModelRow[] = [];
	private expanded = false;
	private loading = false;
	private loaded = false;
	private count = 0;

	constructor(
		document: Document,
		private readonly host: {
			readonly compact?: boolean;
			readonly matches?: (entry: ModelCatalogEntry) => boolean;
			readonly isFiltering?: () => boolean;
			readonly onStorageError?: (error: SecretStorageError) => void;
		},
		@IInstantiationService instantiation: IInstantiationService,
		@INotificationService private readonly notifications: INotificationService,
		@IAccessibleViewService accessibleView: IAccessibleViewService,
		@IConfigurationService configuration: IConfigurationService,
	) {
		super();
		this.viewModel = this._register(instantiation.createInstance(ChatModelsViewModel));
		this.element = h(document, 'section');
		this.element.className = 'ash-chat-models-catalog';
		this.element.setAttribute('aria-label', localize('sessions.settings.chatModels', 'Chat models'));
		this.searchInput = this._register(new InputBox(this.element, {
			inputBoxStyles: defaultInputBoxStyles,
			type: 'search', presentation: 'field',
			ariaLabel: localize('models.catalog.search', 'Search models'),
			placeholder: localize('models.catalog.searchPlaceholder', 'Search model name or ID'),
		}));
		this._register(addDisposableListener(this.searchInput.inputElement, 'keydown', event => {
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
		this.element.append(this.status, this.list, this.message, this.expandRow);
		this._register(this.expandButton.onDidClick(() => {
			this.expanded = !this.expanded;
			this.updateRows();
			this.changed.fire(this.count);
		}));
		this._register(this.searchInput.onDidChange(value => {
			this.viewModel.filter(value);
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
							? this.host.compact ? localize('models.catalog.help', 'Models shows the newest model from each provider. Enabled models appear first; each group keeps the catalog order. Turning a model off restores its place among disabled models. Search models filters the full list by model name or provider/model ID. Escape clears the search and restores the list. Use viewall models to expand or collapse the full catalog. Use Tab and Shift+Tab to move between search, model switches, and buttons. Space toggles whether a model appears in the chat picker. Open Settings configures provider credentials and custom models.')
								: localize('models.catalog.managementHelp', 'Language Models lists models by provider. Search matches names and IDs. Use @provider: followed by a connection ID or quoted provider name to filter providers, and @capability:vision to require declared image input. Search filters offers buttons that insert supported filters. Escape clears the search. Enter or Space on a provider button expands or collapses its models; Collapse All closes all groups. A provider switch changes all models of that connection, including models outside the current search. Model switches control individual picker visibility. Use Tab and Shift+Tab to move between controls. Open Settings configures provider credentials and custom models.')
							: this.accessibleContent(),
						() => { if (focused.isConnected) { focused.focus(); } else { this.focusSearch(); } },
						AccessibilityVerbositySettingId.ChatModelConfiguration);
				},
			}));
		}
		this._register(toDisposable(() => { this.element.remove(); }));
	}

	public get itemCount(): number { return this.count; }
	public focusSearch(): void { this.searchInput.focus(); }
	public search(filter: string): void { this.focusSearch(); this.searchInput.value = filter; }
	public clearSearch(): void { this.search(''); }

	public fireItemCount(): void { this.changed.fire(this.itemCount); }


	/** Editor hosts supply a viewport; Settings retains its own surrounding scroll owner. */
	public layout(height: number, width: number): void {
		this.element.classList.add('is-sized');
		this.element.style.height = `${Math.max(0, height)}px`;
		this.element.style.width = `${Math.max(0, width)}px`;
	}

	public render(): void {
		if (this.viewModel.shouldRefilter()) { this.viewModel.filter(this.searchInput.value); }
		this.updateRows();
		if (!this.loaded && !this.loading) { void this.load(); }
	}

	private accessibleContent(): string {
		return [...this.list.children].map(element => {
			const row = this.rows.find(row => row.element === element);
			if (!row || this.host.compact) { return element.textContent ?? ''; }
			const model = row.entry.model;
			return `${model.displayName}, ${model.model.provider}/${model.model.model}, ${model.hidden ? localize('models.provider.disabled', 'Disabled') : localize('models.provider.enabled', 'Enabled')}`;
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
			if (!ids.has(id)) { this.resources.deleteAndDispose(id); this.providerRows.delete(id); }
		}
		this.rows = modelEntries.map(entry => {
			const row = previous.get(entry.id) ?? this.createRow(entry, entry.id);
			row.entry = entry;
			row.name.textContent = entry.model.displayName;
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
		if (this.host.compact) { desired.push(...shown.map(row => row.element)); }
		else {
			for (const entry of entries) {
				if (isLanguageModelProviderEntry(entry)) { desired.push(this.providerRow(entry)); }
				else if (entry.type === 'model') {
					const row = shown.find(row => row.entry.id === entry.id);
					if (row) { desired.push(row.element); }
				}
			}
		}
		const focused = this.element.ownerDocument.activeElement;
		for (const child of [...this.list.children]) { if (!desired.includes(child as HTMLElement)) { child.remove(); } }
		for (const [index, node] of desired.entries()) {
			if (this.list.children[index] !== node) { this.list.insertBefore(node, this.list.children[index] ?? null); }
		}
		if (isHTMLElement(focused) && this.list.contains(focused) && focused.ownerDocument.activeElement === focused.ownerDocument.body) { focused.focus(); }
		this.count = shown.length;
		const failure = entries.find(isStatusEntry);
		this.message.hidden = !failure && (shown.length > 0 || desired.length > 0);
		this.message.setAttribute('role', failure ? 'alert' : 'status');
		this.message.textContent = failure?.message ?? (this.loaded
			? this.viewModel.getConfiguredVendors().length ? localize('models.catalog.noMatches', 'No models found.') : localize('sessions.settings.noModels', 'No models available.')
			: localize('sessions.settings.modelsLoading', 'Loading models…'));
		this.expandRow.hidden = !this.host.compact || filtering || this.rows.length <= providers.size;
		this.expandButton.domNode.setAttribute('aria-expanded', String(this.expanded));
		this.expandButton.icon = this.expanded ? Lxicon.chevronUp : Lxicon.chevronDown;
		this.collapse.enabled = entries.some(isLanguageModelProviderEntry);
		this.updateFilterSuggestions();
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
			const toggle = resources.add(new Switch(element, { ...defaultToggleStyles, checked: !entry.hidden, ariaLabel: localize('models.catalog.providerVisibility', 'Show {0} models in model picker', entry.label) }));
			row = { entry, element, expand, toggle };
			const current = row;
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
		row.toggle.input.setAttribute('aria-label', localize('models.catalog.providerVisibility', 'Show {0} models in model picker', entry.label));
		return row.element;
	}

	private reportWriteError(): void {
		if (this.isDisposed || this.element.hidden) { return; }
		this.status.textContent = localize('sessions.settings.modelSaveFailed', 'Could not save model visibility.');
		this.status.hidden = false;
		this.notifications.error(this.status.textContent);
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
		name.textContent = entry.model.displayName;
		copy.append(name);
		const toggle = resources.add(new Switch(element, {
			...defaultToggleStyles,
			ariaLabel: localize('sessions.settings.modelVisibility', 'Show {0} in model picker', entry.model.displayName),
			checked: !entry.model.hidden, content: copy, contentPlacement: 'before-control',
		}));
		const row = { entry, element, name, toggle };
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
