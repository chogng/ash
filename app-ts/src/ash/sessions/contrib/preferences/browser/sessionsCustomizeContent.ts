import { h } from '../../../../base/browser/dom.js';
import { TabList, type TabListItem } from '../../../../base/browser/ui/tablist/tabList.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import type { MarketplaceOpenOptions } from '../../../../platform/marketplace/common/marketplaceService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { HooksSettingsContent } from '../../../../workbench/contrib/hooks/browser/hooksSettingsContent.js';
import { MarketplaceContent } from '../../../../workbench/contrib/marketplace/browser/marketplaceViewPane.js';
import { SettingsSearchQuery } from '../../../../workbench/contrib/preferences/browser/settingsSearch.js';
import { SettingsTree } from '../../../../workbench/contrib/preferences/browser/settingsTree.js';
import { SettingsTreeModel, type SettingsContent, type SettingsContentItem, type SettingsTreeNode } from '../../../../workbench/contrib/preferences/browser/settingsTreeModels.js';
import { SkillsSettingsContent } from '../../../../workbench/contrib/skills/browser/skillsSettingsContent.js';

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
	private visible = false;
	private activeTab: CustomizeTab = 'settings';
	private query = new SettingsSearchQuery('');
	private skills: SkillsSettingsContent | undefined;
	private plugins: MarketplaceContent | undefined;
	private hooks: HooksSettingsContent | undefined;

	constructor(container: HTMLElement, private readonly closeSettings: () => Promise<void>, private readonly showEditor: () => void,
		@IInstantiationService private readonly instantiation: IInstantiationService,
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
		this.tree = this._register(new SettingsTree(this.panel, {
			model: this.treeModel,
			rootClassName: 'ash-sessions-customize-tree',
			groupClassName: 'ash-sessions-customize-group',
			groupDescriptionClassName: 'ash-sessions-customize-description',
			itemsClassName: 'ash-sessions-customize-items',
			renderItem: item => item.value.domNode,
		}));
		this._register(toDisposable(() => { this.domNode.remove(); }));
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
			{ element: { kind: 'group', id: 'settings', title: this.tabItems[0].label, description: '' }, children: [] },
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
	}

}
