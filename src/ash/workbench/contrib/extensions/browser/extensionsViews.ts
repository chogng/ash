import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputbox.js';
import { List } from '../../../../base/browser/ui/list/listWidget.js';
import { getHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegate.js';
import { DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IAgentCapabilitiesService } from '../../../../platform/agentCapabilities/common/agentCapabilitiesService.js';
import { IExtensionManagementService } from '../../../../platform/extensionManagement/common/extensionManagementService.js';
import { ViewPane, type IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IChatSessionNavigationService } from '../../../services/chat/common/chatSessionNavigationService.js';
import { IPromptsService } from '../../chat/common/promptSyntax/service/promptsService.js';
import { ExtensionsCapabilityInput, type ExtensionsCapabilityTarget } from '../common/extensionsInput.js';
import './extensions.css';

interface CapabilityListSnapshot {
	readonly items: readonly CapabilityListItem[];
	readonly note?: string;
}

interface CapabilityListItem {
	readonly target: ExtensionsCapabilityTarget;
	readonly name: string;
	readonly description: string;
	readonly metadata: string;
}

/** Each pane retains navigation only; capability state is read from its domain owner. */
abstract class ExtensionsCapabilityViewPane extends ViewPane {
	private readonly query: InputBox;
	private readonly list: List<CapabilityListItem>;
	protected readonly status: HTMLElement;
	private readonly rows = this._register(new DisposableMap<HTMLDivElement, DisposableStore>());
	private items: readonly CapabilityListItem[] = [];
	private generation = 0;
	private catalogNote = '';

	protected constructor(container: HTMLElement, options: IViewPaneOptions, private readonly editors: IEditorService, contextKeys: IContextKeyService, configuration: IConfigurationService) {
		super(container, { ...options, minimumBodySize: 80 });
		const body = h(mainWindow.document, 'section');
		body.className = 'ash-extensions extension-capability-pane';
		this.contentElement.append(body);
		const search = h(mainWindow.document, 'div'); search.className = 'extensions-search'; body.append(search);
		this.query = this._register(new InputBox(search, { type: 'search', presentation: 'compact', placeholder: options.title, ariaLabel: localize({ bundle: 'ash.extensions', key: 'searchPane' }, 'Search {0}', options.title) }));
		this.status = h(mainWindow.document, 'div'); this.status.className = 'extensions-status'; this.status.setAttribute('role', 'status'); body.append(this.status);
		const listContainer = h(mainWindow.document, 'div'); listContainer.className = 'extensions-list'; body.append(listContainer);
		this.list = this._register(new List(listContainer, {
			ariaLabel: options.title, domFocusable: true, keyboardNavigation: true,
			getId: item => JSON.stringify(item.target),
			accessibilityProvider: { getAriaLabel: item => `${item.name}, ${item.description}, ${item.metadata}` },
			keyboardNavigationLabelProvider: { getKeyboardNavigationLabel: item => item.name },
			renderItem: (item, _index, row) => {
				const resources = new DisposableStore(); this.rows.set(row, resources);
				const content = h(mainWindow.document, 'div'); content.className = 'extension-row';
				const labels = h(mainWindow.document, 'div'); labels.className = 'extension-body';
				for (const [className, text] of [['extension-name', item.name], ['extension-description', item.description], ['extension-metadata', item.metadata]]) {
					const label = h(mainWindow.document, 'div'); label.className = className; label.textContent = text;
					resources.add(getHoverDelegate().setupHover({ target: label, content: text })); labels.append(label);
				}
				content.append(labels); return content;
			},
			onDidRemoveRow: row => this.rows.deleteAndDispose(row),
		}));
		this._register(this.list.onDidAccept(({ item }) => { void this.editors.openEditor(new ExtensionsCapabilityInput(item.target)).catch(error => { if (!this.isDisposed) { this.status.textContent = String(error); } }); }));
		this._register(addDisposableListener(this.list.element, 'keydown', event => { if (event.key === 'Enter' && event.target === this.list.element) { event.preventDefault(); this.list.acceptActive(event); } }));
		this._register(this.query.onDidChange(() => this.filter()));
		this._register(this.query.onKeyDown(event => { if (event.key === 'ArrowDown') { event.preventDefault(); this.list.domFocus(); } }));
		this._register(new Button(this.headerActionsElement, { label: localize({ bundle: 'ash.extensions', key: 'refresh' }, 'Refresh'), icon: Lxicon.refresh, iconOnly: true, size: 'small', onClick: () => { void this.refresh(); } }));
		this._register(this.onDidChangeBodyVisibility(visible => { if (visible) { void this.refresh(); } else { ++this.generation; } }));
		const scope = this._register(contextKeys.createScoped(this.element)); scope.createKey('extensionsCapabilitiesFocused', true);
		for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
			this._register(AccessibleViewRegistry.register({
				type, priority: 100, name: `extensions-capabilities-${type}-${generateUuid()}`, when: ContextKeyExpr.has('extensionsCapabilitiesFocused'),
				getProvider: () => {
					const focused = mainWindow.document.activeElement;
					if (!this.isBodyVisible() || !(focused instanceof HTMLElement) || !this.element.contains(focused)) { return undefined; }
					return new AccessibleContentProvider(AccessibleViewProviderId.Extensions, { type }, () => type === AccessibleViewType.Help
						? localize({ bundle: 'ash.extensions', key: 'capabilityHelp' }, 'Extensions contains collapsible Extensions, Plugins, Skills and MCP Servers panes. Use Left and Right on a pane header to collapse or expand it, and Up and Down to move between headers. Search within a pane, use arrow keys to select an item, and Enter to open details in the editor. Skill enablement and diagnostics are in its details. Package installation, permissions and removal are in package details. Refresh reloads the current catalog.')
						: [this.status.textContent, ...this.list.items.map(item => `${item.name}\n${item.description}\n${item.metadata}`)].join('\n\n'), () => focused.focus(), AccessibilityVerbositySettingId.Extensions);
				},
			}));
		}
		this._register(this.onDidFocus(() => { if (configuration.getValue<boolean>('accessibility.verbosity.extensions')) { this.query.element.setAttribute('aria-description', localize({ bundle: 'ash.extensions', key: 'focusHint' }, 'Extensions. Use Tab to navigate and Alt+F1 for help.')); } else { this.query.element.removeAttribute('aria-description'); } }));
	}

	public override focus(): void { this.query.focus(); this.invalidate(); }
	protected abstract readItems(): Promise<CapabilityListSnapshot>;
	protected invalidate(): void { if (this.isBodyVisible()) { void this.refresh(); } }

	public async refresh(): Promise<void> {
		const generation = ++this.generation;
		this.status.textContent = localize({ bundle: 'ash.extensions', key: 'loading' }, 'Loading Extensions…');
		this.contentElement.setAttribute('aria-busy', 'true');
		try {
			const snapshot = await this.readItems();
			if (this.isDisposed || generation !== this.generation) { return; }
			this.items = snapshot.items; this.catalogNote = snapshot.note ?? ''; this.filter();
		} catch (error) {
			if (!this.isDisposed && generation === this.generation) { this.list.items = []; this.status.textContent = error instanceof Error ? error.message : String(error); }
		} finally {
			if (!this.isDisposed && generation === this.generation) { this.contentElement.setAttribute('aria-busy', 'false'); }
		}
	}

	private filter(): void {
		const query = this.query.value.trim().toLowerCase();
		this.list.items = this.items.filter(item => [item.name, item.description, item.metadata].some(text => text.toLowerCase().includes(query)));
		this.status.textContent = [localize({ bundle: 'ash.extensions', key: 'paneResults' }, '{0} items', this.list.items.length), this.catalogNote].filter(Boolean).join(' · ');
	}
}

export class SkillsViewPane extends ExtensionsCapabilityViewPane {
	constructor(container: HTMLElement, options: IViewPaneOptions,
		@IEditorService editors: IEditorService, @IContextKeyService contextKeys: IContextKeyService, @IConfigurationService configuration: IConfigurationService,
		@IPromptsService private readonly prompts: IPromptsService, @IChatSessionNavigationService private readonly sessions: IChatSessionNavigationService,
		@IExtensionManagementService extensions: IExtensionManagementService,
	) {
		super(container, options, editors, contextKeys, configuration);
		this._register(prompts.onDidChangeSkills(() => this.invalidate()));
		this._register(extensions.onDidChangeInstalled(() => this.invalidate()));
		this._register(editors.onDidActiveEditorChange(() => this.invalidate()));
	}

	protected async readItems(): Promise<CapabilityListSnapshot> {
		const sessionId = this.sessions.getActiveConversation()?.sessionId;
		const snapshot = await this.prompts.readSkillManagement(sessionId);
		if (sessionId !== this.sessions.getActiveConversation()?.sessionId) { throw new Error(localize({ bundle: 'ash.extensions', key: 'skillScopeChanged' }, 'The active conversation changed. Refresh Skills.')); }
		return {
			note: snapshot.diagnostics.map(entry => `${entry.source}${entry.subject ? ` / ${entry.subject}` : ''}: ${entry.message}`).join('\n'), items: snapshot.catalog.skills.map(skill => ({
				target: { kind: 'skill', source: skill.id.source, name: skill.id.name, sessionId }, name: skill.name, description: skill.description,
				metadata: `${skill.id.source} · ${skill.enabled ? localize({ bundle: 'ash.extensions', key: 'enabledState' }, 'Enabled') : localize({ bundle: 'ash.extensions', key: 'disabledState' }, 'Disabled')}`,
			}))
		};
	}
}

export class McpServersViewPane extends ExtensionsCapabilityViewPane {
	constructor(container: HTMLElement, options: IViewPaneOptions,
		@IEditorService editors: IEditorService, @IContextKeyService contextKeys: IContextKeyService, @IConfigurationService configuration: IConfigurationService,
		@IExtensionManagementService private readonly extensions: IExtensionManagementService, @IAgentCapabilitiesService private readonly capabilities: IAgentCapabilitiesService,
	) {
		super(container, options, editors, contextKeys, configuration);
		this._register(extensions.onDidChangeInstalled(() => this.invalidate()));
	}

	protected async readItems(): Promise<CapabilityListSnapshot> {
		const installed = await this.extensions.listInstalled();
		const items: CapabilityListItem[] = installed.flatMap(installation => installation.capabilities.filter(capability => capability.kind === 'mcp').map(capability => ({
			target: { kind: 'mcp' as const, serverId: capability.id, installationId: installation.installationId, capabilityId: capability.reference.id },
			name: capability.id, description: installation.package.id, metadata: localize({ bundle: 'ash.extensions', key: 'installedFilter' }, 'Installed'),
		})));
		if (this.capabilities.isAvailable) {
			const catalog = await this.capabilities.read();
			for (const set of catalog.toolSets.filter(set => set.source === 'mcp')) {
				if (items.some(item => item.name === set.sourceId)) { continue; }
				items.push({ target: { kind: 'mcp', serverId: set.sourceId }, name: set.sourceId, description: localize({ bundle: 'ash.extensions', key: 'mcpToolsCount' }, '{0} registered tools', set.tools.length), metadata: localize({ bundle: 'ash.extensions', key: 'mcpRegistered' }, 'Registered') });
			}
		}
		return { items };
	}
}
