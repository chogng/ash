import { SettingsPageRenderer, SettingsRenderer } from '../../../../workbench/contrib/preferences/browser/settingsRenderers.js';
import { h } from '../../../../base/browser/dom.js';
import { TabList, type TabListItem } from '../../../../base/browser/ui/tablist/tabList.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { AICustomizationManagementEditorInput } from '../../../../workbench/contrib/chat/browser/aiCustomization/aiCustomizationManagementEditorInput.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { AccessibleViewProviderId, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { SettingsSectionRenderer } from '../../../../workbench/contrib/preferences/browser/settingsSectionRenderer.js';
import { SettingsSearchQuery } from '../../../../workbench/contrib/preferences/browser/settingsSearch.js';
import { SettingsTree } from '../../../../workbench/contrib/preferences/browser/settingsTree.js';
import { SettingsTreeModel, type SettingsSectionReference, type SettingsTreeNode } from '../../../../workbench/contrib/preferences/browser/settingsTreeModels.js';

type CustomizeTab = 'settings' | 'hooks';

/** Owns Customize navigation; each domain retains its content and operation state across tabs. */
export class SessionsCustomizeContent extends SettingsPageRenderer {
	public readonly categoryId = 'customize';
	public readonly domNode: HTMLElement;
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChange = this.changed.event;
	private readonly tabs: TabList<CustomizeTab>;
	private readonly tabItems: readonly TabListItem<CustomizeTab>[];
	private readonly panel: HTMLElement;
	private readonly treeModel = this._register(new SettingsTreeModel<SettingsSectionReference>());
	private readonly tree: SettingsTree<SettingsSectionReference>;
	private readonly renderer: SettingsRenderer;
	private visible = false;
	private activeTab: CustomizeTab = 'settings';
	private query = new SettingsSearchQuery('');
	private hooks: SettingsSectionRenderer | undefined;
	private settings: SettingsSectionRenderer | undefined;

	constructor(
		container: HTMLElement,
		private readonly closeSettings: () => Promise<void>,
		private readonly showEditor: () => void,
		private readonly openSettingsEditor: () => Promise<void>,
		private readonly openUserSettings: () => Promise<void>,
		@IInstantiationService private readonly instantiation: IInstantiationService,
	) {
		super();
		const document = container.ownerDocument;
		this.domNode = h(document, 'section');
		this.domNode.className = 'ash-sessions-customize';
		this.tabs = this._register(
			new TabList(this.domNode, {
				ariaLabel: localize('sessions.customize.tabs', 'Customize tabs'),
				presentation: 'inset',
				onActivate: tab => this.selectTab(tab),
			}),
		);
		this.panel = h(document, 'div');
		this.panel.id = 'ash-sessions-customize-panel';
		this.panel.setAttribute('role', 'tabpanel');
		this.tabItems = [
			{
				id: 'settings',
				value: 'settings',
				label: localize('sessions.customize.settings', 'Settings'),
				tabId: 'ash-sessions-customize-settings',
				panelId: this.panel.id,
			},
			{
				id: 'hooks',
				value: 'hooks',
				label: localize('sessions.customize.hooks', 'Hooks'),
				tabId: 'ash-sessions-customize-hooks',
				panelId: this.panel.id,
			},
		];
		this.domNode.append(this.panel);
		this.renderer = this._register(this.instantiation.createInstance(SettingsRenderer, this.panel, {}));
		this.tree = this._register(
			new SettingsTree(this.panel, {
				model: this.treeModel,
				rootClassName: 'ash-sessions-customize-tree',
				groupClassName: 'ash-sessions-customize-group',
				groupDescriptionClassName: 'ash-sessions-customize-description',
				itemsClassName: 'ash-sessions-customize-items',
				renderItem: item => this.renderer.render(item.value),
			}),
		);
		this._register(
			toDisposable(() => {
				this.domNode.remove();
			}),
		);
		this.render();
	}

	public selectTab(tab: CustomizeTab): void {
		this.activeTab = tab;
		this.render();
	}

	public setVisible(visible: boolean): void {
		if (this.visible === visible) return;
		this.visible = visible;
		this.render();
	}

	protected override buildNodes(query: SettingsSearchQuery): readonly SettingsTreeNode<SettingsSectionReference>[] {
		this.query = query;
		this.render();
		const keywords = [...this.tabItems.flatMap(tab => [tab.id, tab.label]), ...this.treeModel.visibleItems.flatMap(item => [item.title, item.description, ...(item.keywords ?? [])])];
		return [
			{
				element: {
					kind: 'item',
					id: 'sessions.customize',
					title: localize('sessions.settings.customize', 'Customize'),
					description: '',
					keywords,
					value: this.retainElement('sessions.customize', this.domNode),
				},
			},
		];
	}

	private render(): void {
		const searching = !this.query.isEmpty;
		let contentCreated = false;
		const isActive = (tab: CustomizeTab): boolean => this.visible && (searching || this.activeTab === tab);
		if (isActive('settings') && !this.settings) {
			this.settings = this._register(
				this.instantiation.createInstance(
					SettingsSectionRenderer,
					this.panel,
					{
						categoryId: 'customize-settings',
						title: this.tabItems[0].label,
						description: localize('sessions.customize.settingsDescription', 'Edit shared Workbench preferences using the settings editor or the current profile’s settings.json file.'),
						help: localize(
							'sessions.customize.settingsHelp',
							'Open Workbench Settings to search, change or reset settings. Open User Settings (JSON) to edit the profile’s settings.json file. Both use the same configuration owner as the Workbench.',
						),
						onDidChange: Event.None,
						fields: [
							{
								id: 'editor',
								kind: 'action',
								enabled: true,
								label: localize('sessions.customize.openSettings', 'Open Workbench Settings'),
								run: this.openSettingsEditor,
							},
							{
								id: 'json',
								kind: 'action',
								enabled: true,
								label: localize({ bundle: 'ash.settings', key: 'json.openCommand' }, 'Preferences: Open User Settings (JSON)'),
								run: this.openUserSettings,
							},
						],
						setVisible: () => {},
					},
					AccessibleViewProviderId.SessionsSettings,
					AccessibilityVerbositySettingId.SessionsSettings,
				),
			);
			this._register(this.renderer.registerPage(this.settings));
			contentCreated = true;
		}
		if (isActive('hooks') && !this.hooks) {
			this.hooks = this._register(
				this.instantiation.createInstance(
					SettingsSectionRenderer,
					this.panel,
					{
						categoryId: 'hooks',
						title: localize({ bundle: 'ash.settings', key: 'hooks.aria' }, 'Agent Hooks'),
						description: localize({ bundle: 'ash.settings', key: 'hooks.managementLink' }, 'Manage Hooks in Agent Customizations.'),
						help: localize(
							{ bundle: 'ash.settings', key: 'hooks.managementLinkHelp' },
							'Open Manage Hooks to search events, inspect declarations, edit TOML, or ask Ash to configure a Hook.',
						),
						onDidChange: Event.None,
						fields: [
							{
								id: 'manage',
								kind: 'action',
								label: localize({ bundle: 'ash.settings', key: 'hooks.manage' }, 'Manage Hooks'),
								enabled: true,
								run: async () => {
									// Closing the modal releases its child service scope. Resolve the window owner first.
									const editors = this.instantiation.invokeFunction(accessor => accessor.get(IEditorService));
									await this.closeSettings();
									await editors.openEditor(new AICustomizationManagementEditorInput(), {
										pinned: true,
									});
									this.showEditor();
								},
							},
						],
						setVisible: () => {},
					},
					AccessibleViewProviderId.HooksSettings,
					AccessibilityVerbositySettingId.HooksSettings,
				),
			);
			this._register(this.renderer.registerPage(this.hooks));
			contentCreated = true;
		}
		const nodes: SettingsTreeNode<SettingsSectionReference>[] = [
			{
				element: { kind: 'group', id: 'settings', title: this.tabItems[0].label, description: '' },
				children: (this.settings?.getNodes() as readonly SettingsTreeNode<SettingsSectionReference>[]) ?? [],
			},
			{
				element: { kind: 'group', id: 'hooks', title: this.tabItems[1].label, description: '' },
				children: (this.hooks?.getNodes() as readonly SettingsTreeNode<SettingsSectionReference>[]) ?? [],
			},
		];
		this.treeModel.setChildren(nodes);
		this.tree.setNavigationTarget(searching ? undefined : this.activeTab);
		this.treeModel.setQuery(this.query);
		this.tabs.element.hidden = searching;
		this.tabs.setTabs(this.tabItems, this.activeTab);
		this.panel.setAttribute('aria-labelledby', `ash-sessions-customize-${this.activeTab}`);
		this.hooks?.setVisible(isActive('hooks'));
		this.settings?.setVisible(isActive('settings'));
		// The outer search must refilter once lazily created action labels are available.
		if (contentCreated) this.changed.fire();
	}
}
