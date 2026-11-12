import { h } from '../../../../../../base/browser/dom.js';
import { AnchorAlignment, AnchorPosition, ContextViewFocusRestore, ContextViewHideReason } from '../../../../../../base/browser/ui/contextview/contextview.js';
import { Menu } from '../../../../../../base/browser/ui/menu/menu.js';
import { Action, type IAction, Separator, SubmenuAction } from '../../../../../../base/common/actions.js';
import { Keybinding, logicalKey, resolveKeybinding } from '../../../../../../base/common/keybindings.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../../../base/common/lxicons.js';
import { localize } from '../../../../../../nls.js';
import { IContextViewService } from '../../../../../../platform/contextview/browser/contextView.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../../platform/storage/common/storage.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { IProjectService } from '../../../../../../platform/projects/common/projectService.js';
import { IConnectorService } from '../../../../../../platform/connectors/common/connectorService.js';
import { IPluginManagementService } from '../../../../../../platform/extensionManagement/common/pluginManagementService.js';
import { defaultButtonStyles, defaultMenuStyles } from '../../../../../../platform/theme/browser/defaultStyles.js';
import type { SkillSelectorDefinition } from '../../../../../services/chat/common/chatService.js';
import type { SkillReference } from '../../../../../../platform/agentHost/common/appServerApi.js';
import type { Icon } from '../../../../../../base/common/icon.js';
import { status as announceStatus } from '../../../../../../base/browser/ui/aria/aria.js';

const uploadKeybinding = resolveKeybinding(Keybinding.single(logicalKey('u', { primaryKey: true })));

const STORAGE_KEY_WEB_SEARCH = 'ash.chat.attachMenu.webSearch.enabled';
const STORAGE_KEY_MEMORY = 'ash.chat.attachMenu.memory.enabled';

export interface ChatInputAttachMenuOptions {
	readonly anchor: HTMLElement;
	readonly onUploadFiles: () => void;
	readonly showUploadKeybinding?: false;
	readonly onSearchAttachments?: () => void;
	readonly onAttachSkill?: (skill: SkillReference) => void;
	readonly getSkills?: () => readonly SkillSelectorDefinition[];
	/** Product-owned entries for this composer, alongside its attachment and Skill actions. */
	readonly host?: {
		readonly getWorkspaceAction?: () => IAction | undefined;
		readonly getProjectActions?: () => readonly IAction[] | undefined;
		readonly additionalActions?: readonly IAction[];
	};
	readonly onSelectProject?: (projectId: string) => void;
	readonly focusInput?: () => void;
	readonly onClose?: () => void;
}

interface MenuItemDef {
	readonly id: string;
	readonly label: string;
	readonly icon?: Icon;
	readonly checked?: boolean;
	readonly onToggle?: (checked: boolean) => void;
	readonly run?: () => void;
	readonly getSubmenuItems?: () => Promise<readonly SubmenuItemDef[]> | readonly SubmenuItemDef[];
}

interface SubmenuItemDef {
	readonly id: string;
	readonly label: string;
	readonly icon?: Icon;
	readonly iconColor?: string;
	readonly isSeparator?: boolean;
	readonly disabled?: boolean;
	readonly checked?: boolean;
	readonly run?: () => void;
}

export class ChatInputAttachMenu extends Disposable {
	private readonly projectService: IProjectService | undefined;
	private readonly connectorService: IConnectorService | undefined;
	private readonly pluginService: IPluginManagementService | undefined;

	private readonly openMenu = this._register(new MutableDisposable<DisposableStore>());

	private webSearchEnabled = true;
	private memoryEnabled = true;

	constructor(
		private readonly options: ChatInputAttachMenuOptions,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@ICommandService private readonly commandService: ICommandService,
		@IStorageService private readonly storageService: IStorageService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this.projectService = instantiationService.getOptional(IProjectService);
		this.connectorService = instantiationService.getOptional(IConnectorService);
		this.pluginService = instantiationService.getOptional(IPluginManagementService);

		this.webSearchEnabled = this.storageService.getBoolean(STORAGE_KEY_WEB_SEARCH, StorageScope.PROFILE, true);
		this.memoryEnabled = this.storageService.getBoolean(STORAGE_KEY_MEMORY, StorageScope.PROFILE, true);
	}

	show(): void {
		if (this.openMenu.value) {
			this.close();
			return;
		}

		const lifetime = new DisposableStore();
		this.openMenu.value = lifetime;
		const { anchor } = this.options;
		const host = h(anchor.ownerDocument, 'div');
		const actions = this.buildMenuItems().map(item => this.createMenuAction(item, lifetime));
		const menu = lifetime.add(new Menu(host, actions, {
			ariaLabel: localize('chat.attach.menuLabel', 'Add content or context'),
			buttonStyles: defaultButtonStyles,
			iconPlacement: 'leading-with-trailing-check',
			getCheckedActionsRepresentation: action => action.id.startsWith('project:') ? 'radio' : 'checkbox',
			getKeyBinding: action => action.id === 'upload' && this.options.showUploadKeybinding !== false ? uploadKeybinding : undefined,
			openSubmenusImmediatelyOnHover: true,
			tabLeavesSubmenu: true,
		}, defaultMenuStyles));
		lifetime.add(menu.onDidCancel(() => this.close()));

		anchor.setAttribute('aria-expanded', 'true');
		const shown = this.contextViewService.show({
			anchor,
			anchorPosition: AnchorPosition.Below,
			anchorAlignment: AnchorAlignment.Left,
			gap: 6,
			layer: 20,
			presentation: 'menu',
			content: menu.getContainer(),
			focusRestore: ContextViewFocusRestore.Previous,
			blockOutsidePointer: true,
			isTargetWithin: target => menu.contains(target),
			onHide: reason => {
				anchor.setAttribute('aria-expanded', 'false');
				this.openMenu.clear();
				if (reason === ContextViewHideReason.Escape) {
					this.options.focusInput?.();
				}
				if (reason !== ContextViewHideReason.Replaced) {
					this.options.onClose?.();
				}
			},
		});

		if (shown) {
			menu.focusFirst();
		}
	}

	private close(): void {
		if (this.openMenu.value) this.contextViewService.hide();
	}

	override dispose(): void {
		this.close();
		super.dispose();
	}

	private createMenuAction(item: MenuItemDef, lifetime: DisposableStore): IAction {
		if (item.id === 'divider') return new Separator();
		const getSubmenuItems = item.getSubmenuItems;
		if (getSubmenuItems) {
			return new SubmenuAction(item.id, item.label, [
				this.createSubmenuAction({ id: 'loading', label: localize('chat.attach.loading', 'Loading…'), disabled: true }),
			], item.icon, async () => {
				const children = await getSubmenuItems();
				return children.length
					? children.map(child => this.createSubmenuAction(child))
					: [this.createSubmenuAction({ id: 'no-items', label: localize('chat.attach.noItems', 'No items available'), disabled: true })];
			});
		}

		const action = lifetime.add(new Action(item.id, item.label, '', true, () => {
			if (item.onToggle) {
				const checked = !action.checked;
				action.checked = checked;
				item.onToggle(checked);
			} else {
				this.close();
				item.run?.();
			}
		}));
		action.icon = item.icon;
		action.checked = item.checked;
		return action;
	}

	private createSubmenuAction(item: SubmenuItemDef): IAction {
		if (item.isSeparator) return new Separator();
		return {
			id: item.id,
			label: item.label,
			icon: item.icon,
			iconColor: item.iconColor,
			tooltip: '',
			enabled: !item.disabled,
			checked: item.checked,
			run: () => {
				this.close();
				item.run?.();
			},
		};
	}

	private buildMenuItems(): readonly MenuItemDef[] {
		const attachments: MenuItemDef[] = [
			{
				id: 'upload',
				label: localize('chat.attach.uploadOrAddFiles', 'Upload or add files'),
				icon: Lxicon.paperclip,
				run: () => this.options.onUploadFiles(),
			},
			...(this.options.onSearchAttachments ? [{
				id: 'searchAttachments',
				label: localize('chat.context.searchAttachments', 'Search attachments'),
				icon: Lxicon.search,
				run: this.options.onSearchAttachments,
			}] : []),
		];
		const host = this.options.host;
		const skillsItem: MenuItemDef = {
			id: 'skills',
			label: localize('chat.attach.skills', 'Skills'),
			icon: Lxicon.skill,
			getSubmenuItems: () => this.getSkillsSubmenuItems(!host),
		};
		if (host) {
			for (const action of host.additionalActions ?? []) {
				if (action.enabled) attachments.push({ id: action.id, label: action.label, icon: action.icon, run: () => void action.run() });
			}
			const projects = host.getProjectActions?.();
			if (projects) {
				attachments.push({
					id: 'project',
					label: localize('chat.attach.addToProject', 'Add to project'),
					icon: Lxicon.projects,
					getSubmenuItems: () => projects.length
						? projects.map(project => ({
							id: `project:${project.id}`, label: project.label, icon: project.icon,
							iconColor: project.iconColor,
							checked: project.checked, disabled: !project.enabled,
							run: () => void project.run(),
						}))
						: [{ id: 'no-projects', label: localize('chat.attach.noProjects', 'No projects'), disabled: true }],
				});
			}
			const workspace = host.getWorkspaceAction?.();
			if (workspace?.enabled) {
				attachments.push({
					id: workspace.id, label: workspace.label, icon: workspace.icon,
					run: () => void workspace.run(),
				});
			}
			const skills = this.options.getSkills?.() ?? [];
			if (skills.length && this.options.onAttachSkill) {
				attachments.push(skillsItem);
			}
			return attachments;
		}
		return [
			...attachments,
			// 2. Add to project
			{
				id: 'project',
				label: localize('chat.attach.addToProject', 'Add to project'),
				icon: Lxicon.projects,
				getSubmenuItems: () => this.getProjectSubmenuItems(),
			},
			// Divider
			{ id: 'divider', label: '' },
			// 3. Skills
			skillsItem,
			// 4. Add connector
			{
				id: 'connectors',
				label: localize('chat.attach.addConnector', 'Add connector'),
				icon: Lxicon.connectors,
				getSubmenuItems: () => this.getConnectorSubmenuItems(),
			},
			// 5. Design system
			{
				id: 'design',
				label: localize('chat.attach.designSystem', 'Design system'),
				icon: Lxicon.design,
				getSubmenuItems: () => this.getDesignSystemSubmenuItems(),
			},
			// 6. Plugins
			{
				id: 'plugins',
				label: localize('chat.attach.plugins', 'Plugins'),
				icon: Lxicon.plug,
				getSubmenuItems: () => this.getPluginSubmenuItems(),
			},
			// Divider
			{ id: 'divider', label: '' },
			// 7. Web search
			{
				id: 'websearch',
				label: localize('chat.attach.webSearch', 'Web search'),
				icon: Lxicon.website,
				checked: this.webSearchEnabled,
				onToggle: checked => {
					this.webSearchEnabled = checked;
					this.storageService.store(STORAGE_KEY_WEB_SEARCH, checked, StorageScope.PROFILE, StorageTarget.USER);
					try {
						announceStatus(checked
							? localize('chat.attach.webSearchEnabled', 'Web search enabled')
							: localize('chat.attach.webSearchDisabled', 'Web search disabled'));
					} catch {
						// Ignore in environments where ARIA container is not mounted
					}
				},
			},
			// 8. Memory
			{
				id: 'memory',
				label: localize('chat.attach.memory', 'Memory'),
				icon: Lxicon.brain,
				checked: this.memoryEnabled,
				onToggle: checked => {
					this.memoryEnabled = checked;
					this.storageService.store(STORAGE_KEY_MEMORY, checked, StorageScope.PROFILE, StorageTarget.USER);
					try {
						announceStatus(checked
							? localize('chat.attach.memoryEnabled', 'Memory enabled')
							: localize('chat.attach.memoryDisabled', 'Memory disabled'));
					} catch {
						// Ignore in environments where ARIA container is not mounted
					}
				},
			},
		];
	}

	private async getProjectSubmenuItems(): Promise<readonly SubmenuItemDef[]> {
		const items: SubmenuItemDef[] = [];
		try {
			if (this.projectService) {
				const summaries = await this.projectService.list('chat').catch(() => []);
				const active = summaries.filter(p => !p.archived);
				for (const project of active) {
					items.push({
						id: `project:${project.id}`,
						label: project.name,
						icon: Lxicon.projects,
						run: () => {
							this.options.onSelectProject?.(project.id);
							void this.commandService.executeCommand('sessions.open.projects', project.id).catch(() => undefined);
						},
					});
				}
			}
		} catch {
			// Ignore project reading error
		}

		if (items.length > 0) {
			items.push({ id: 'project-sep', label: '', isSeparator: true });
		} else {
			items.push({
				id: 'no-projects',
				label: localize('chat.attach.noProjects', 'No projects'),
				disabled: true,
			});
		}

		items.push({
			id: 'new-project',
			label: localize('chat.attach.newProject', 'New project…'),
			icon: Lxicon.newFolder,
			run: () => void this.commandService.executeCommand('sessions.open.projects').catch(() => undefined),
		});

		return items;
	}

	private getSkillsSubmenuItems(includeBrowse: boolean): readonly SubmenuItemDef[] {
		const items: SubmenuItemDef[] = [];
		const skills = this.options.getSkills?.() ?? [];

		for (const def of skills) {
			items.push({
				id: `skill:${def.name}`,
				label: def.name,
				icon: Lxicon.skill,
				run: () => {
					if (def.skill && this.options.onAttachSkill) {
						this.options.onAttachSkill(def.skill);
					}
				},
			});
		}

		if (!includeBrowse) return items;
		if (items.length > 0) {
			items.push({ id: 'skills-sep', label: '', isSeparator: true });
		}

		items.push({
			id: 'browse-skills',
			label: localize('chat.attach.browseSkills', 'Browse skills…'),
			icon: Lxicon.search,
			run: () => void this.commandService.executeCommand('sessions.open.customize', { category: 'skills', collection: 'discover' }).catch(() => undefined),
		});

		return items;
	}

	private async getConnectorSubmenuItems(): Promise<readonly SubmenuItemDef[]> {
		const items: SubmenuItemDef[] = [];
		try {
			if (this.connectorService) {
				const catalog = await this.connectorService.list().catch(() => undefined);
				if (catalog?.connectors) {
					for (const conn of catalog.connectors) {
						items.push({
							id: `connector:${conn.id}`,
							label: conn.displayName,
							icon: Lxicon.connectors,
							run: () => void this.commandService.executeCommand('sessions.open.customize', { category: 'connectors', collection: 'yours', query: conn.displayName }).catch(() => undefined),
						});
					}
				}
			}
		} catch {
			// Ignore connector read failure
		}

		if (items.length > 0) {
			items.push({ id: 'connectors-sep', label: '', isSeparator: true });
		}

		items.push({
			id: 'browse-connectors',
			label: localize('chat.attach.browseConnectors', 'Browse connectors…'),
			icon: Lxicon.search,
			run: () => void this.commandService.executeCommand('sessions.open.customize', { category: 'connectors', collection: 'discover' }).catch(() => undefined),
		});

		return items;
	}

	private getDesignSystemSubmenuItems(): readonly SubmenuItemDef[] {
		return [
			{
				id: 'artifacts',
				label: localize('chat.attach.artifacts', 'Artifacts'),
				icon: Lxicon.artifacts,
				run: () => void this.commandService.executeCommand('sessions.open.creator').catch(() => undefined),
			},
			{
				id: 'theme-editor',
				label: localize('chat.attach.themeEditor', 'Theme editor'),
				icon: Lxicon.design,
				run: () => void this.commandService.executeCommand('workbench.action.openThemeEditor').catch(() => undefined),
			},
		];
	}

	private async getPluginSubmenuItems(): Promise<readonly SubmenuItemDef[]> {
		const items: SubmenuItemDef[] = [];
		try {
			if (this.pluginService) {
				const catalog = await this.pluginService.list().catch(() => undefined);
				if (catalog?.packages) {
					for (const plugin of catalog.packages) {
						items.push({
							id: `plugin:${plugin.id}`,
							label: plugin.displayName || plugin.id,
							icon: Lxicon.plug,
							run: () => void this.commandService.executeCommand('sessions.open.customize', { category: 'plugins', collection: 'yours', query: plugin.displayName || plugin.id }).catch(() => undefined),
						});
					}
				}
			}
		} catch {
			// Ignore plugin listing error
		}

		if (items.length > 0) {
			items.push({ id: 'plugins-sep', label: '', isSeparator: true });
		}

		items.push({
			id: 'browse-plugins',
			label: localize('chat.attach.browsePlugins', 'Browse plugins…'),
			icon: Lxicon.search,
			run: () => void this.commandService.executeCommand('sessions.open.customize', { category: 'plugins', collection: 'discover' }).catch(() => undefined),
		});

		return items;
	}
}
