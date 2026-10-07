import { ILanguageModelsService } from '../common/languageModels.js';
import './media/advisorSettingsContent.css';
import { h, isHTMLElement } from '../../../../base/browser/dom.js';
import { Dropdown } from '../../../../base/browser/ui/dropdown/dropdown.js';
import { Menu } from '../../../../base/browser/ui/menu/menu.js';
import { type IAction, Separator } from '../../../../base/common/actions.js';
import { Switch } from '../../../../base/browser/ui/toggle/toggle.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IChatService, type AdvisorConfig } from '../../../services/chat/common/chatService.js';
import { modelRefIdentity, type ModelCatalogEntry } from '../../../services/chat/common/modelCatalog.js';
import { ILocalizationService } from '../../../services/localization/common/localizationService.js';
import type { SettingsContent, SettingsContentItem, SettingsTreeNode } from '../../preferences/browser/settingsTreeModels.js';

// This is a menu shortlist, not a second model catalog. Metadata and availability come from Models.
const flagshipModels: Readonly<Record<string, readonly string[]>> = {
	openai: ['gpt-6.1-sol', 'gpt-6-astra'], anthropic: ['claude-opus-5-5', 'claude-fable-5-1'],
	xai: ['grok-4.7'], meta: ['muse-spark-1.3'], google: ['gemini-3.1-pro-preview'],
	kimi: ['kimi-k3'], deepseek: ['deepseek-v4-pro'],
	glm: ['glm-5.3'],
};

/** Both settings hosts edit the chat service's saved Advisor preference. */
export class AdvisorSettingsContent extends Disposable implements SettingsContent {
	public readonly categoryId = 'agents';
	public readonly domNode: HTMLElement;
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChange = this.changed.event;
	private readonly note: HTMLElement;
	private readonly status: HTMLElement;
	private readonly advisor: Dropdown;
	private readonly menuDisposables = this._register(new DisposableStore());
	private readonly enabled: Switch;
	private readonly enabledLabel: HTMLElement;
	private readonly title: HTMLElement;
	private menu: Menu | undefined;
	private selectedMenuIndex = -1;
	private models: readonly ModelCatalogEntry[] = [];
	private savedAdvisor: AdvisorConfig | null = null;
	private loaded = false;
	private working = false;
	private visible = false;
	private loadVersion = 0;

	constructor(container: HTMLElement,
		@IChatService private readonly chat: IChatService,
		@ILanguageModelsService private readonly languageModels: ILanguageModelsService,
		@IContextViewService contextView: IContextViewService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IAccessibleViewService accessibleView: IAccessibleViewService,
		@IConfigurationService configuration: IConfigurationService,
		@ILocalizationService localization: ILocalizationService,
	) {
		super();
		const document = container.ownerDocument;
		this.domNode = h(document, 'section');
		this.domNode.className = 'ash-advisor-settings ash-settings-card';
		this.domNode.setAttribute('role', 'group');
		const modelRow = h(document, 'div');
		modelRow.className = 'ash-advisor-settings-row';
		const copy = h(document, 'div');
		copy.className = 'ash-advisor-settings-copy';
		this.title = h(document, 'h4');
		this.note = h(document, 'p');
		copy.append(this.title, this.note);
		modelRow.append(copy);
		this.domNode.append(modelRow);
		this.advisor = this._register(new Dropdown(modelRow, {
			label: localize('advisor.settings.disabled', 'Disable'),
			content: () => this.createModelMenu(), contextViewProvider: contextView,
			contentWidth: 'at-least-trigger', ariaLabel: localize('advisor.settings.model', 'Advisor model'),
		}));
		this.advisor.button.setAttribute('aria-haspopup', 'menu');
		this._register(this.advisor.onDidChangeVisibility(({ visible }) => {
			if (visible) { this.menu?.focus(this.selectedMenuIndex); }
		}));
		const enabledRow = h(document, 'div');
		enabledRow.className = 'ash-advisor-settings-row';
		this.enabledLabel = h(document, 'span');
		enabledRow.append(this.enabledLabel);
		this.enabled = this._register(new Switch(enabledRow, { disabled: true }));
		this.domNode.append(enabledRow);
		this.status = h(document, 'p');
		this.status.className = 'ash-advisor-settings-status';
		this.status.setAttribute('role', 'status');
		this.domNode.append(this.status);
		this._register(this.enabled.onDidChange(() => { void this.saveAdvisor(this.savedAdvisor ? { ...this.savedAdvisor, enabled: this.enabled.checked } : null); }));
		this.updateLabels();
		this._register(toDisposable(() => { this.loadVersion++; this.domNode.remove(); }));
		const updateHint = (): void => {
			const hint = accessibleView.getOpenAriaHint(AccessibilityVerbositySettingId.ChatModelConfiguration);
			if (hint) { this.domNode.setAttribute('aria-description', hint); }
			else { this.domNode.removeAttribute('aria-description'); }
		};
		updateHint();
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(AccessibilityVerbositySettingId.ChatModelConfiguration)) { updateHint(); }
		}));
		const scoped = this._register(contextKeys.createScoped(this.domNode));
		scoped.createKey('advisorSettingsFocused', true);
		this._register(AccessibleViewRegistry.register({
			type: AccessibleViewType.Help, priority: 110, name: `advisor-settings-${generateUuid()}`,
			when: ContextKeyExpr.has('advisorSettingsFocused'),
			getProvider: () => {
				const focused = document.activeElement;
				if (!this.visible || !isHTMLElement(focused) || !this.domNode.contains(focused)) { return undefined; }
				return new AccessibleContentProvider(AccessibleViewProviderId.ChatModelConfiguration, { type: AccessibleViewType.Help },
					() => localize('advisor.settings.help', 'Advisor settings\nAdvisor provides a second opinion during chats. Use Tab and Shift+Tab to reach the model and enable switch. Open the model menu with Enter or Space, choose with arrow keys, and confirm with Enter. Space toggles Enable Advisor. Changes are saved immediately. Disabling keeps the selected model. The menu lists flagship models enabled in Models. Selecting a model enables Advisor; Disable turns it off and remembers the model.'),
					() => focused.focus(), AccessibilityVerbositySettingId.ChatModelConfiguration);
			},
		}));
		this._register(this.languageModels.onDidChangeModels(() => {
			this.advisor.hide();
			if (this.visible && !this.working) { void this.loadSettings(); }
		}));
		this.updateControls();
	}

	public getNodes(): readonly SettingsTreeNode<SettingsContentItem>[] {
		return [{
			element: {
				kind: 'item', id: 'chat.advisor', title: localize('advisor.settings.title', 'Advisor'),
				description: this.note.textContent ?? '', keywords: ['advisor', 'model', 'second opinion', localize('advisor.settings.model', 'Advisor model'), localize('advisor.settings.enabled', 'Enable Advisor')],
				value: { domNode: this.domNode },
			}
		}];
	}

	public setVisible(visible: boolean): void {
		if (this.visible === visible) { return; }
		this.visible = visible;
		if (visible && !this.working) { void this.loadSettings(); }
	}

	private async loadSettings(): Promise<void> {
		const version = ++this.loadVersion;
		this.working = true;
		this.updateControls();
		this.status.textContent = localize('advisor.settings.loading', 'Loading Advisor settings…');
		try {
			const [models, advisor] = await Promise.all([this.languageModels.listAdvisorModels(), this.chat.readAdvisorDefault()]);
			if (this.isDisposed || version !== this.loadVersion) { return; }
			this.savedAdvisor = advisor;
			this.models = models;
			this.updateModelLabel();
			this.enabled.checked = advisor?.enabled ?? false;
			this.loaded = true;
			this.status.textContent = '';
		} catch (error) {
			if (!this.isDisposed && version === this.loadVersion) {
				this.status.textContent = localize('advisor.settings.loadFailed', 'Could not load Advisor settings: {0}', String(error));
			}
		} finally {
			if (!this.isDisposed && version === this.loadVersion) {
				this.working = false;
				this.updateControls();
				this.changed.fire();
			}
		}
	}

	private async saveAdvisor(next: AdvisorConfig | null): Promise<void> {
		this.working = true;
		this.updateControls();
		try {
			await this.chat.saveAdvisorDefault(next);
			if (this.isDisposed) { return; }
			this.savedAdvisor = next;
			this.updateModelLabel();
			this.enabled.checked = next?.enabled ?? false;
			this.status.textContent = localize('advisor.settings.saved', 'Advisor settings saved.');
		} catch (error) {
			if (this.isDisposed) { return; }
			this.updateModelLabel();
			this.enabled.checked = this.savedAdvisor?.enabled ?? false;
			this.status.textContent = localize('advisor.settings.saveFailed', 'Could not save Advisor settings: {0}', String(error));
		} finally {
			if (!this.isDisposed) { this.working = false; this.updateControls(); }
		}
	}

	private updateControls(): void {
		this.advisor.enabled = this.loaded && !this.working;
		this.enabled.enabled = this.loaded && !this.working && !!this.savedAdvisor;
	}

	private updateLabels(): void {
		this.domNode.setAttribute('aria-label', localize('advisor.settings.title', 'Advisor'));
		this.note.textContent = localize('advisor.settings.description', 'Advisor provides a second opinion during chats. Choose its model and enable it here. Models and API connections are managed in Models.');
		this.advisor.button.setAttribute('aria-label', localize('advisor.settings.model', 'Advisor model'));
		this.title.textContent = localize('advisor.settings.model', 'Advisor model');
		this.enabledLabel.textContent = localize('advisor.settings.enabled', 'Enable Advisor');
		this.enabled.setAriaLabel(this.enabledLabel.textContent);
		this.updateModelLabel();
	}

	private updateModelLabel(): void {
		const advisor = this.savedAdvisor;
		const selected = advisor && this.models.find(entry => modelRefIdentity(entry.model) === modelRefIdentity(advisor.model));
		// Hiding a model changes menu choices, not the saved preference or the trigger's label.
		const label = advisor?.enabled ? selected?.displayName ?? `${advisor.model.provider}/${advisor.model.model}` : localize('advisor.settings.disabled', 'Disable');
		this.advisor.setLabel(label);
		this.advisor.button.title = label;
	}

	private createModelMenu(): HTMLElement {
		this.menuDisposables.clear();
		const disable: IAction = {
			id: 'advisor.disable', label: localize('advisor.settings.disabled', 'Disable'), tooltip: '', enabled: true,
			checked: !this.savedAdvisor?.enabled,
			run: () => this.saveAdvisor(this.savedAdvisor ? { ...this.savedAdvisor, enabled: false } : null),
		};
		const models = this.models.filter(entry => flagshipModels[entry.model.provider]?.includes(entry.model.model) && this.languageModels.isModelVisible(entry.model));
		const modelActions: IAction[] = models.map(entry => ({
			id: modelRefIdentity(entry.model), label: entry.displayName, tooltip: '', enabled: true,
			checked: !!this.savedAdvisor?.enabled && modelRefIdentity(this.savedAdvisor.model) === modelRefIdentity(entry.model),
			run: () => this.saveAdvisor({
				model: entry.model, enabled: true,
				maxCalls: this.savedAdvisor?.maxCalls ?? 3, maxOutputTokens: this.savedAdvisor?.maxOutputTokens ?? 2048,
				reasoningEffort: this.savedAdvisor?.reasoningEffort && entry.supportedReasoningEfforts?.some(option => option.effort === this.savedAdvisor?.reasoningEffort) ? this.savedAdvisor.reasoningEffort : undefined,
			}),
		}));
		const actions = [disable, ...(modelActions.length ? [new Separator(), ...modelActions] : [])];
		this.selectedMenuIndex = actions.findIndex(action => action.checked);
		this.menu = this.menuDisposables.add(new Menu(h(this.domNode.ownerDocument, 'div'), {
			actions,
			getCheckedActionsRepresentation: () => 'radio',
			onDidSelect: () => this.advisor.hide(),
			onDidRequestClose: () => this.advisor.hide(),
		}));
		return this.menu.element;
	}
}
