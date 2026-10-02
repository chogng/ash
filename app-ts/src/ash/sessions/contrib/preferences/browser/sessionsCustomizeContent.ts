import { h } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { SelectBox } from '../../../../base/browser/ui/selectbox/selectbox.js';
import { TabList, type TabListItem } from '../../../../base/browser/ui/tablist/tabList.js';
import { Switch } from '../../../../base/browser/ui/toggle/toggle.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import type { MarketplaceOpenOptions } from '../../../../platform/marketplace/common/marketplaceService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { HooksSettingsContent } from '../../../../workbench/contrib/hooks/browser/hooksSettingsContent.js';
import { MarketplaceContent } from '../../../../workbench/contrib/marketplace/browser/marketplaceViewPane.js';
import { SettingsSearchQuery } from '../../../../workbench/contrib/preferences/browser/settingsSearch.js';
import { SettingsTree } from '../../../../workbench/contrib/preferences/browser/settingsTree.js';
import { SettingsTreeModel, type SettingsContent, type SettingsContentItem, type SettingsTreeNode } from '../../../../workbench/contrib/preferences/browser/settingsTreeModels.js';
import { SkillsSettingsContent } from '../../../../workbench/contrib/skills/browser/skillsSettingsContent.js';
import { IChatService, type AdvisorConfig } from '../../../../workbench/services/chat/common/chatService.js';
import { modelRefIdentity, type ModelCatalogEntry } from '../../../../workbench/services/chat/common/modelCatalog.js';

type CustomizeTab = 'settings' | 'plugins' | 'skills' | 'hooks';

/** Owns Customize navigation; each domain retains its content and operation state across tabs. */
export class SessionsCustomizeContent extends Disposable implements SettingsContent {
	public readonly categoryId = 'customize';
	public readonly domNode: HTMLElement;
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChange = this.changed.event;
	private readonly tabs: TabList<CustomizeTab>;
	private readonly tabItems: readonly TabListItem<CustomizeTab>[];
	private readonly panel: HTMLElement;
	private readonly treeModel = this._register(new SettingsTreeModel<SettingsContentItem>());
	private readonly tree: SettingsTree<SettingsContentItem>;
	private readonly settings: HTMLElement;
	private readonly status: HTMLElement;
	private readonly advisor: SelectBox;
	private readonly enabled: Switch;
	private readonly refreshButton: Button;
	private models: readonly ModelCatalogEntry[] = [];
	private savedAdvisor: AdvisorConfig | null = null;
	private settingsLoaded = false;
	private working = false;
	private visible = false;
	private loadVersion = 0;
	private activeTab: CustomizeTab = 'settings';
	private query = new SettingsSearchQuery('');
	private skills: SkillsSettingsContent | undefined;
	private plugins: MarketplaceContent | undefined;
	private hooks: HooksSettingsContent | undefined;

	constructor(container: HTMLElement, private readonly closeSettings: () => Promise<void>, private readonly showEditor: () => void,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IChatService private readonly chat: IChatService,
		@IContextViewService contextView: IContextViewService,
	) {
		super();
		const document = container.ownerDocument;
		this.domNode = h(document, 'section');
		this.domNode.className = 'ash-sessions-customize';
		this.tabs = this._register(new TabList(this.domNode, {
			ariaLabel: localize('sessions.customize.tabs', 'Customize tabs'),
			presentation: 'inset',
			onActivate: tab => this.selectTab(tab),
		}));
		this.panel = h(document, 'div');
		this.panel.id = 'ash-sessions-customize-panel';
		this.panel.setAttribute('role', 'tabpanel');
		this.tabItems = [
			{ id: 'settings', value: 'settings', label: localize('sessions.customize.settings', 'Settings'), tabId: 'ash-sessions-customize-settings', panelId: this.panel.id },
			{ id: 'plugins', value: 'plugins', label: localize('sessions.settings.plugins', 'Plugins'), tabId: 'ash-sessions-customize-plugins', panelId: this.panel.id },
			{ id: 'skills', value: 'skills', label: localize('skills.title', 'Skills'), tabId: 'ash-sessions-customize-skills', panelId: this.panel.id },
			{ id: 'hooks', value: 'hooks', label: localize('sessions.customize.hooks', 'Hooks'), tabId: 'ash-sessions-customize-hooks', panelId: this.panel.id },
		];
		this.domNode.append(this.panel);
		this.settings = h(document, 'section');
		this.settings.className = 'ash-sessions-customize-settings';
		const note = h(document, 'p');
		note.textContent = localize('sessions.customize.advisorDescription', 'Choose the saved Advisor preference used by chats. Models and API connections are managed in Models.');
		this.status = h(document, 'p');
		this.status.setAttribute('role', 'status');
		this.advisor = this._register(new SelectBox(this.settings, { options: [], presentation: 'field', contextViewProvider: contextView }));
		this.advisor.setAriaLabel(localize('sessions.customize.advisorModel', 'Advisor model'));
		this.enabled = this._register(new Switch(this.settings, { label: localize('sessions.customize.advisorEnabled', 'Enable Advisor'), disabled: true }));
		this.refreshButton = this._register(new Button(this.settings, { label: localize('skills.refresh', 'Refresh'), presentation: 'secondary', onClick: () => { void this.loadSettings(); } }));
		this.settings.prepend(note);
		this.settings.append(this.status);
		this._register(this.advisor.onDidSelect(() => { void this.saveAdvisor(); }));
		this._register(this.enabled.onDidChange(() => { void this.saveAdvisor(); }));
		this.tree = this._register(new SettingsTree(this.panel, {
			model: this.treeModel,
			rootClassName: 'ash-sessions-customize-tree',
			groupClassName: 'ash-sessions-customize-group',
			groupDescriptionClassName: 'ash-sessions-customize-description',
			itemsClassName: 'ash-sessions-customize-items',
			renderItem: item => item.value.domNode,
		}));
		this._register(toDisposable(() => { this.loadVersion++; this.domNode.remove(); }));
		this.render();
	}

	public selectTab(tab: CustomizeTab): void {
		this.activeTab = tab;
		this.render();
	}

	public async openPlugins(options: MarketplaceOpenOptions): Promise<void> {
		this.selectTab('plugins');
		await this.plugins!.open(options);
	}

	public setVisible(visible: boolean): void {
		if (this.visible === visible) return;
		this.visible = visible;
		this.render();
	}

	public getNodes(query: SettingsSearchQuery): readonly SettingsTreeNode<SettingsContentItem>[] {
		this.query = query;
		this.render();
		const keywords = [...this.tabItems.flatMap(tab => [tab.id, tab.label]), ...this.treeModel.visibleItems.flatMap(item => [item.title, item.description, ...item.keywords ?? []])];
		return [{ element: { kind: 'item', id: 'sessions.customize', title: localize('sessions.settings.customize', 'Customize'), description: '', keywords, value: { domNode: this.domNode } } }];
	}

	private render(): void {
		const searching = !this.query.isEmpty;
		const isActive = (tab: CustomizeTab): boolean => this.visible && (searching || this.activeTab === tab);
		if (isActive('skills') && !this.skills) {
			this.skills = this._register(this.instantiation.createInstance(SkillsSettingsContent, this.panel));
			this._register(this.skills.onDidChange(() => this.changed.fire()));
		}
		if (isActive('plugins') && !this.plugins) {
			this.plugins = this._register(this.instantiation.createInstance(MarketplaceContent, this.panel, { mode: 'installed' }));
			this._register(this.plugins.onDidChange(() => this.changed.fire()));
		}
		if (isActive('hooks') && !this.hooks) {
			this.hooks = this._register(this.instantiation.createInstance(HooksSettingsContent, this.panel, this.closeSettings));
			this._register(this.hooks.onDidChange(() => { this.render(); this.changed.fire(); }));
			// The settings dialog's top layer must release focus to the opened editor.
			this._register(this.hooks.onDidOpenConfiguration(resource => { void this.closeSettings().then(() => { if (resource) this.showEditor(); }); }));
		}
		const item = (id: string, title: string, domNode: HTMLElement): SettingsTreeNode<SettingsContentItem> => ({ element: { kind: 'item', id, title, description: domNode.textContent ?? '', value: { domNode } } });
		const nodes: SettingsTreeNode<SettingsContentItem>[] = [
			{ element: { kind: 'group', id: 'settings', title: this.tabItems[0].label, description: '' }, children: [item('customize.advisor', localize('sessions.customize.advisorModel', 'Advisor model'), this.settings)] },
			{ element: { kind: 'group', id: 'plugins', title: this.tabItems[1].label, description: '' }, children: this.plugins ? [item('customize.plugins', this.tabItems[1].label, this.plugins.domNode)] : [] },
			{ element: { kind: 'group', id: 'skills', title: this.tabItems[2].label, description: '' }, children: this.skills?.getNodes() ?? [] },
			{ element: { kind: 'group', id: 'hooks', title: this.tabItems[3].label, description: '' }, children: this.hooks?.getNodes(this.query) as readonly SettingsTreeNode<SettingsContentItem>[] ?? [] },
		];
		this.treeModel.setChildren(nodes);
		this.tree.setNavigationTarget(searching ? undefined : this.activeTab);
		this.treeModel.setQuery(this.query);
		this.tabs.element.hidden = searching;
		this.tabs.setTabs(this.tabItems, this.activeTab);
		this.panel.setAttribute('aria-labelledby', `ash-sessions-customize-${this.activeTab}`);
		this.skills?.setVisible(isActive('skills'));
		this.plugins?.setVisible(isActive('plugins'));
		this.hooks?.setVisible(isActive('hooks'));
		if (isActive('settings') && !this.settingsLoaded && !this.working) void this.loadSettings();
	}

	private async loadSettings(): Promise<void> {
		const version = ++this.loadVersion;
		this.working = true;
		this.updateControls();
		this.status.textContent = localize('sessions.customize.loading', 'Loading session settings…');
		try {
			const [models, advisor] = await Promise.all([this.chat.listAdvisorModels(), this.chat.readAdvisorDefault()]);
			if (this.isDisposed || version !== this.loadVersion) return;
			this.savedAdvisor = advisor;
			const available = advisor && models.some(entry => modelRefIdentity(entry.model) === modelRefIdentity(advisor.model));
			this.models = advisor && !available ? [...models, { model: advisor.model, displayName: `${advisor.model.provider}/${advisor.model.model}` }] : models;
			this.advisor.setOptions([
				{ value: '', label: localize('sessions.customize.noAdvisor', 'No saved Advisor') },
				...this.models.map(entry => ({ value: modelRefIdentity(entry.model), label: entry.displayName })),
			]);
			this.advisor.value = advisor ? modelRefIdentity(advisor.model) : '';
			this.enabled.checked = advisor?.enabled ?? false;
			this.status.textContent = '';
		} catch (error) {
			if (!this.isDisposed && version === this.loadVersion) this.status.textContent = localize('sessions.customize.failed', 'Could not load session settings: {0}', String(error));
		} finally {
			if (!this.isDisposed && version === this.loadVersion) {
				this.settingsLoaded = true;
				this.working = false;
				this.updateControls();
				this.changed.fire();
			}
		}
	}

	private async saveAdvisor(): Promise<void> {
		const selected = this.advisor.value ? this.models.find(entry => modelRefIdentity(entry.model) === this.advisor.value)!.model : undefined;
		const next = selected ? { model: selected, enabled: this.enabled.checked, maxCalls: this.savedAdvisor?.maxCalls ?? 3, maxOutputTokens: this.savedAdvisor?.maxOutputTokens ?? 2048, reasoningEffort: this.savedAdvisor?.reasoningEffort } : null;
		this.working = true;
		this.updateControls();
		try {
			await this.chat.saveAdvisorDefault(next);
			if (this.isDisposed) return;
			this.savedAdvisor = next;
			this.status.textContent = localize('sessions.customize.saved', 'Session settings saved.');
		} catch (error) {
			if (this.isDisposed) return;
			this.advisor.value = this.savedAdvisor ? modelRefIdentity(this.savedAdvisor.model) : '';
			this.enabled.checked = this.savedAdvisor?.enabled ?? false;
			this.status.textContent = localize('sessions.customize.saveFailed', 'Could not save session settings: {0}', String(error));
		} finally {
			if (!this.isDisposed) { this.working = false; this.updateControls(); }
		}
	}

	private updateControls(): void {
		this.advisor.enabled = !this.working;
		this.enabled.enabled = !this.working && !!this.advisor.value;
		this.refreshButton.enabled = !this.working;
	}
}
