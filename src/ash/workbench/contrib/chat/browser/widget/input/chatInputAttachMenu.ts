import './media/chatInputAttachMenu.css';
import { addDisposableListener, h, stopEvent } from '../../../../../../base/browser/dom.js';
import { isMacintosh } from '../../../../../../base/common/platform.js';
import { appendIcon } from '../../../../../../base/browser/ui/lxicons/lxicon.js';
import { Lxicon } from '../../../../../../base/common/lxicons.js';
import { localize } from '../../../../../../nls.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { AnchorAlignment, AnchorAxisAlignment, AnchorPosition, ContextView, ContextViewFocusRestore, ContextViewHideReason } from '../../../../../../base/browser/ui/contextview/contextview.js';
import { IContextViewService } from '../../../../../../platform/contextview/browser/contextView.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../../platform/storage/common/storage.js';
import { IInstantiationService } from '../../../../../../platform/instantiation/common/instantiation.js';
import { IProjectService } from '../../../../../../platform/projects/common/projectService.js';
import { IConnectorService } from '../../../../../../platform/connectors/common/connectorService.js';
import { IMemoriesService } from '../../../../../../platform/memories/common/memoriesService.js';
import { IPluginManagementService } from '../../../../../../platform/extensionManagement/common/pluginManagementService.js';
import type { SkillSelectorDefinition } from '../../../../../services/chat/common/chatService.js';
import type { SkillReference } from '../../../../../../platform/agentHost/common/appServerApi.js';
import type { Icon } from '../../../../../../base/common/icon.js';
import { status as announceStatus } from '../../../../../../base/browser/ui/aria/aria.js';

const STORAGE_KEY_WEB_SEARCH = 'ash.chat.attachMenu.webSearch.enabled';
const STORAGE_KEY_MEMORY = 'ash.chat.attachMenu.memory.enabled';

export interface ChatInputAttachMenuOptions {
	readonly anchor: HTMLElement;
	readonly onUploadFiles: () => void;
	readonly onAttachSkill?: (skill: SkillReference) => void;
	readonly getSkills?: () => readonly SkillSelectorDefinition[];
	readonly onSelectProject?: (projectId: string) => void;
	readonly focusInput?: () => void;
	readonly onClose?: () => void;
}

interface MenuItemDef {
	readonly id: string;
	readonly label: string;
	readonly icon?: Icon;
	readonly shortcut?: string;
	readonly hasSubmenu?: boolean;
	readonly checked?: boolean;
	readonly isToggle?: boolean;
	readonly onToggle?: (checked: boolean) => void;
	readonly run?: () => void;
	readonly getSubmenuItems?: () => Promise<readonly SubmenuItemDef[]> | readonly SubmenuItemDef[];
}

interface SubmenuItemDef {
	readonly id: string;
	readonly label: string;
	readonly icon?: Icon;
	readonly isSeparator?: boolean;
	readonly disabled?: boolean;
	readonly run?: () => void;
}

export class ChatInputAttachMenu extends Disposable {
	private readonly projectService: IProjectService | undefined;
	private readonly connectorService: IConnectorService | undefined;
	private readonly memoriesService: IMemoriesService | undefined;
	private readonly pluginService: IPluginManagementService | undefined;

	private readonly openSubmenu = this._register(new MutableDisposable<DisposableStore>());
	private activeSubmenuHost: HTMLElement | undefined;
	private menuElement: HTMLElement | undefined;
	private items: readonly MenuItemDef[] = [];
	private itemElements: HTMLElement[] = [];
	private focusedIndex = 0;
	private isOpen = false;

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
		this.memoriesService = instantiationService.getOptional(IMemoriesService);
		this.pluginService = instantiationService.getOptional(IPluginManagementService);

		this.webSearchEnabled = this.storageService.getBoolean(STORAGE_KEY_WEB_SEARCH, StorageScope.PROFILE, true);
		this.memoryEnabled = this.storageService.getBoolean(STORAGE_KEY_MEMORY, StorageScope.PROFILE, true);
	}

	public show(): void {
		if (this.isOpen) {
			this.close();
			return;
		}

		this.isOpen = true;
		this.options.anchor.setAttribute('aria-expanded', 'true');

		const ownerDocument = this.options.anchor.ownerDocument;
		const menu = h(ownerDocument, 'div', { className: 'ash-chat-attach-menu' });
		menu.setAttribute('role', 'menu');
		menu.tabIndex = -1;
		menu.setAttribute('aria-label', localize('chat.attach.menuLabel', 'Add content or context'));
		this.menuElement = menu;

		this.items = this.buildMenuItems();
		this.itemElements = [];

		let itemIndex = 0;
		for (const def of this.items) {
			if (def.id === 'divider') {
				const divider = h(ownerDocument, 'div', { className: 'ash-chat-attach-menu-divider' });
				divider.setAttribute('role', 'separator');
				menu.append(divider);
				continue;
			}

			const currentIndex = itemIndex;
			const row = h(ownerDocument, 'div', { className: 'ash-chat-attach-menu-item' });
			row.setAttribute('role', def.isToggle ? 'menuitemcheckbox' : 'menuitem');
			row.tabIndex = -1;
			row.setAttribute('aria-label', def.label);

			if (def.isToggle) {
				row.setAttribute('aria-checked', String(def.checked ?? false));
			}
			if (def.hasSubmenu) {
				row.setAttribute('aria-haspopup', 'menu');
				row.setAttribute('aria-expanded', 'false');
			}

			// Leading icon
			if (def.icon) {
				const iconSlot = h(ownerDocument, 'span', { className: 'ash-chat-attach-menu-item-icon' });
				iconSlot.setAttribute('aria-hidden', 'true');
				appendIcon(def.icon, iconSlot);
				row.append(iconSlot);
			}

			// Label
			const labelSlot = h(ownerDocument, 'span', { className: 'ash-chat-attach-menu-item-label' }, def.label);
			row.append(labelSlot);

			// Trailing container
			const trailingSlot = h(ownerDocument, 'span', { className: 'ash-chat-attach-menu-item-trailing' });
			if (def.shortcut) {
				const shortcut = h(ownerDocument, 'span', { className: 'ash-chat-attach-menu-item-shortcut' }, def.shortcut);
				shortcut.setAttribute('aria-hidden', 'true');
				trailingSlot.append(shortcut);
			} else if (def.hasSubmenu) {
				const chevron = h(ownerDocument, 'span', { className: 'ash-chat-attach-menu-item-arrow' });
				chevron.setAttribute('aria-hidden', 'true');
				appendIcon(Lxicon.chevronRight, chevron);
				trailingSlot.append(chevron);
			} else if (def.isToggle) {
				const checkSlot = h(ownerDocument, 'span', {
					className: `ash-chat-attach-menu-item-check${def.checked ? '' : ' hidden'}`,
				});
				checkSlot.setAttribute('aria-hidden', 'true');
				appendIcon(Lxicon.check, checkSlot);
				trailingSlot.append(checkSlot);
			}
			row.append(trailingSlot);

			// Hover & pointer events
			this._register(addDisposableListener(row, 'mouseenter', () => {
				this.focusItem(currentIndex);
				if (def.hasSubmenu) {
					this.showSubmenu(row, def);
				} else {
					this.closeSubmenu();
				}
			}));

			this._register(addDisposableListener(row, 'click', event => {
				stopEvent(event);
				if (def.isToggle) {
					const currentlyChecked = row.getAttribute('aria-checked') === 'true';
					const next = !currentlyChecked;
					row.setAttribute('aria-checked', String(next));
					const check = row.querySelector('.ash-chat-attach-menu-item-check');
					check?.classList.toggle('hidden', !next);
					def.onToggle?.(next);
				} else if (def.hasSubmenu) {
					this.showSubmenu(row, def);
				} else {
					this.close();
					def.run?.();
				}
			}));

			menu.append(row);
			this.itemElements.push(row);
			itemIndex++;
		}

		// Keyboard navigation on main menu
		this._register(addDisposableListener(menu, 'keydown', event => {
			switch (event.key) {
				case 'ArrowDown':
					stopEvent(event);
					this.focusNext();
					break;
				case 'ArrowUp':
					stopEvent(event);
					this.focusPrevious();
					break;
				case 'ArrowRight': {
					const currentDef = this.items.filter(item => item.id !== 'divider')[this.focusedIndex];
					if (currentDef?.hasSubmenu) {
						stopEvent(event);
						const row = this.itemElements[this.focusedIndex];
						if (row) this.showSubmenu(row, currentDef, true);
					}
					break;
				}
				case 'Enter':
				case ' ': {
					stopEvent(event);
					const currentDef = this.items.filter(item => item.id !== 'divider')[this.focusedIndex];
					const row = this.itemElements[this.focusedIndex];
					if (currentDef && row) {
						row.click();
					}
					break;
				}
				case 'Escape':
					stopEvent(event);
					this.close();
					this.options.focusInput?.();
					break;
				case 'Tab':
					this.close();
					break;
			}
		}));

		const shown = this.contextViewService.show({
			anchor: this.options.anchor,
			anchorPosition: AnchorPosition.Below,
			anchorAlignment: AnchorAlignment.Left,
			gap: 6,
			presentation: 'plain',
			content: menu,
			focusRestore: ContextViewFocusRestore.Previous,
			blockOutsidePointer: true,
			isTargetWithin: target => {
				return menu.contains(target) || (this.activeSubmenuHost ? this.activeSubmenuHost.contains(target) : false);
			},
			onHide: reason => {
				this.isOpen = false;
				this.openSubmenu.clear();
				this.activeSubmenuHost = undefined;
				this.options.anchor.setAttribute('aria-expanded', 'false');
				if (reason !== ContextViewHideReason.Replaced) {
					this.options.onClose?.();
				}
			},
		});

		if (shown) {
			this.focusItem(0);
		}
	}

	public close(): void {
		if (!this.isOpen) return;
		this.isOpen = false;
		this.openSubmenu.clear();
		this.activeSubmenuHost = undefined;
		this.contextViewService.hide();
		this.options.anchor.setAttribute('aria-expanded', 'false');
		this.options.onClose?.();
	}

	private focusNext(): void {
		const next = (this.focusedIndex + 1) % this.itemElements.length;
		this.focusItem(next);
	}

	private focusPrevious(): void {
		const prev = (this.focusedIndex - 1 + this.itemElements.length) % this.itemElements.length;
		this.focusItem(prev);
	}

	private focusItem(index: number): void {
		if (index < 0 || index >= this.itemElements.length) return;
		for (let i = 0; i < this.itemElements.length; i++) {
			this.itemElements[i].classList.toggle('focused', i === index);
		}
		this.focusedIndex = index;
		this.itemElements[index]?.focus();
	}

	private buildMenuItems(): readonly MenuItemDef[] {
		const shortcutU = isMacintosh ? '⌘U' : 'Ctrl+U';

		return [
			// 1. Upload or add files
			{
				id: 'upload',
				label: localize('chat.attach.uploadOrAddFiles', 'Upload or add files'),
				icon: Lxicon.paperclip,
				shortcut: shortcutU,
				run: () => this.options.onUploadFiles(),
			},
			// 2. Add to project
			{
				id: 'project',
				label: localize('chat.attach.addToProject', 'Add to project'),
				icon: Lxicon.projects,
				hasSubmenu: true,
				getSubmenuItems: async () => this.getProjectSubmenuItems(),
			},
			// Divider
			{ id: 'divider', label: '' },
			// 3. Skills
			{
				id: 'skills',
				label: localize('chat.attach.skills', 'Skills'),
				icon: Lxicon.skill,
				hasSubmenu: true,
				getSubmenuItems: () => this.getSkillsSubmenuItems(),
			},
			// 4. Add connector
			{
				id: 'connectors',
				label: localize('chat.attach.addConnector', 'Add connector'),
				icon: Lxicon.connectors,
				hasSubmenu: true,
				getSubmenuItems: async () => this.getConnectorSubmenuItems(),
			},
			// 5. Design system
			{
				id: 'design',
				label: localize('chat.attach.designSystem', 'Design system'),
				icon: Lxicon.design,
				hasSubmenu: true,
				getSubmenuItems: () => this.getDesignSystemSubmenuItems(),
			},
			// 6. Plugins
			{
				id: 'plugins',
				label: localize('chat.attach.plugins', 'Plugins'),
				icon: Lxicon.plug,
				hasSubmenu: true,
				getSubmenuItems: async () => this.getPluginSubmenuItems(),
			},
			// Divider
			{ id: 'divider', label: '' },
			// 7. Web search
			{
				id: 'websearch',
				label: localize('chat.attach.webSearch', 'Web search'),
				icon: Lxicon.website,
				isToggle: true,
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
				isToggle: true,
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

	private async showSubmenu(anchorRow: HTMLElement, def: MenuItemDef, focusFirst = false): Promise<void> {
		this.closeSubmenu();

		const lifetime = new DisposableStore();
		this.openSubmenu.value = lifetime;

		anchorRow.setAttribute('aria-expanded', 'true');
		lifetime.add(toDisposable(() => anchorRow.setAttribute('aria-expanded', 'false')));

		const ownerDocument = anchorRow.ownerDocument;
		const container = this.contextViewService.container;
		const submenu = h(ownerDocument, 'div', {
			className: 'ash-chat-attach-menu ash-chat-attach-submenu',
		});
		submenu.setAttribute('role', 'menu');
		submenu.tabIndex = -1;
		submenu.setAttribute('aria-label', def.label);

		this.activeSubmenuHost = submenu;
		lifetime.add(toDisposable(() => {
			submenu.remove();
			if (this.activeSubmenuHost === submenu) this.activeSubmenuHost = undefined;
		}));

		const loadingRow = h(ownerDocument, 'div', {
			className: 'ash-chat-attach-menu-item disabled',
		}, localize('chat.attach.loading', 'Loading…'));
		loadingRow.tabIndex = -1;
		submenu.append(loadingRow);

		// Position submenu next to anchorRow
		const childContextView = lifetime.add(new ContextView(container));
		const shown = childContextView.show({
			anchor: anchorRow,
			anchorAxisAlignment: AnchorAxisAlignment.Horizontal,
			anchorAlignment: AnchorAlignment.Left,
			gap: 4,
			presentation: 'plain',
			content: submenu,
			focusRestore: ContextViewFocusRestore.None,
			isTargetWithin: target => submenu.contains(target) || (this.menuElement ? this.menuElement.contains(target) : false),
		});

		if (!shown) return;

		const subItems = await (def.getSubmenuItems?.() ?? []);
		if (lifetime.isDisposed) return;

		submenu.replaceChildren();

		if (!subItems.length) {
			const emptyRow = h(ownerDocument, 'div', {
				className: 'ash-chat-attach-menu-item disabled',
			}, localize('chat.attach.noItems', 'No items available'));
			emptyRow.tabIndex = -1;
			submenu.append(emptyRow);
			return;
		}

		const rows: HTMLElement[] = [];
		for (const item of subItems) {
			if (item.isSeparator) {
				const div = h(ownerDocument, 'div', { className: 'ash-chat-attach-menu-divider' });
				div.setAttribute('role', 'separator');
				submenu.append(div);
				continue;
			}

			const row = h(ownerDocument, 'div', {
				className: `ash-chat-attach-menu-item${item.disabled ? ' disabled' : ''}`,
			});
			row.setAttribute('role', 'menuitem');
			row.tabIndex = -1;
			row.setAttribute('aria-label', item.label);

			if (item.icon) {
				const iconSlot = h(ownerDocument, 'span', { className: 'ash-chat-attach-menu-item-icon' });
				iconSlot.setAttribute('aria-hidden', 'true');
				appendIcon(item.icon, iconSlot);
				row.append(iconSlot);
			}

			const label = h(ownerDocument, 'span', { className: 'ash-chat-attach-menu-item-label' }, item.label);
			row.append(label);

			if (!item.disabled) {
				lifetime.add(addDisposableListener(row, 'mouseenter', () => {
					for (const r of rows) r.classList.remove('focused');
					row.classList.add('focused');
					row.focus();
				}));

				lifetime.add(addDisposableListener(row, 'click', event => {
					stopEvent(event);
					this.close();
					item.run?.();
				}));
			}

			submenu.append(row);
			if (!item.disabled) rows.push(row);
		}

		// Keyboard navigation inside submenu
		let subFocused = 0;
		lifetime.add(addDisposableListener(submenu, 'keydown', event => {
			switch (event.key) {
				case 'ArrowDown':
					stopEvent(event);
					subFocused = (subFocused + 1) % rows.length;
					for (let i = 0; i < rows.length; i++) rows[i].classList.toggle('focused', i === subFocused);
					rows[subFocused]?.focus();
					break;
				case 'ArrowUp':
					stopEvent(event);
					subFocused = (subFocused - 1 + rows.length) % rows.length;
					for (let i = 0; i < rows.length; i++) rows[i].classList.toggle('focused', i === subFocused);
					rows[subFocused]?.focus();
					break;
				case 'ArrowLeft':
				case 'Escape':
					stopEvent(event);
					this.closeSubmenu();
					anchorRow.focus();
					break;
				case 'Enter':
				case ' ':
					stopEvent(event);
					rows[subFocused]?.click();
					break;
			}
		}));

		if (focusFirst && rows.length > 0) {
			subFocused = 0;
			rows[0].classList.add('focused');
			rows[0].focus();
		}
	}

	private closeSubmenu(): void {
		this.openSubmenu.clear();
		this.activeSubmenuHost = undefined;
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
						icon: Lxicon.folder,
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

	private getSkillsSubmenuItems(): readonly SubmenuItemDef[] {
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

		if (items.length > 0) {
			items.push({ id: 'skills-sep', label: '', isSeparator: true });
		}

		items.push({
			id: 'browse-skills',
			label: localize('chat.attach.browseSkills', 'Browse skills…'),
			icon: Lxicon.search,
			run: () => void this.commandService.executeCommand('sessions.open.customize').catch(() => undefined),
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
							run: () => void this.commandService.executeCommand('sessions.open.customize').catch(() => undefined),
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
			run: () => void this.commandService.executeCommand('sessions.open.customize').catch(() => undefined),
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
							run: () => void this.commandService.executeCommand('sessions.open.customize').catch(() => undefined),
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
			run: () => void this.commandService.executeCommand('sessions.open.customize').catch(() => undefined),
		});

		return items;
	}
}
