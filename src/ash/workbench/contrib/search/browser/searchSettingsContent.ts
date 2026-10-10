import './media/searchSettingsContent.css';
import { h, isHTMLElement } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { SelectBox } from '../../../../base/browser/ui/selectbox/selectbox.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IContentSearchConfigurationService, type ContentSearchConfiguration, type ContentSearchEngine } from '../../../../platform/search/common/search.js';
import type { ISetting } from '../../../services/preferences/common/preferences.js';
import { IAppServerRemoteAgentService } from '../../../services/remote/common/appServerRemoteAgentService.js';
import type { SettingsContent, SettingsContentItem, SettingsTreeNode } from '../../preferences/browser/settingsTreeModels.js';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.ContentSearchSettings,
	defaultValue: true,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') { throw new TypeError('Content search accessibility verbosity must be boolean'); }
		return value;
	},
	setting: {
		valueType: 'boolean',
		get title() { return localize({ bundle: 'ash.settings', key: 'search.verbosity' }, 'Content search accessibility help'); },
		get description() { return localize({ bundle: 'ash.settings', key: 'search.verbosityDescription' }, 'Announce how to open accessibility help in content search settings.'); },
	},
});

type Status = 'loading' | 'ready' | 'saving' | 'saved' | 'readFailed' | 'saveFailed' | 'disconnected';

/** The backend configuration revision is authoritative; this control never writes frontend settings.json. */
export class SearchSettingsContent extends Disposable implements SettingsContent {
	public readonly categoryId = 'search';
	public readonly onDidChange = Event.None;
	private readonly rowDomNode: HTMLElement;
	private readonly titleDomNode: HTMLElement;
	private readonly descriptionDomNode: HTMLElement;
	private readonly statusDomNode: HTMLElement;
	private readonly engine: SelectBox;
	private readonly refreshButton: Button;
	private snapshot: ContentSearchConfiguration | undefined;
	private state: Status = 'loading';
	private visible = false;
	private busy = false;
	// Reconnection can replace the service while a read or save is pending.
	private version = 0;

	constructor(container: HTMLElement,
		@IContentSearchConfigurationService private readonly search: IContentSearchConfigurationService,
		@IContextViewService contextView: IContextViewService,
		@IAppServerRemoteAgentService remote: IAppServerRemoteAgentService,
		@IConfigurationService configuration: IConfigurationService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IAccessibleViewService accessibleView: IAccessibleViewService,
	) {
		super();
		const document = container.ownerDocument;
		this.rowDomNode = h(document, 'div');
		this.rowDomNode.className = 'ash-configuration-setting';
		const copy = h(document, 'div');
		copy.className = 'ash-configuration-setting-copy';
		this.titleDomNode = h(document, 'h5');
		this.titleDomNode.className = 'ash-configuration-setting-title';
		this.descriptionDomNode = h(document, 'p');
		this.descriptionDomNode.className = 'ash-configuration-setting-description';
		this.statusDomNode = h(document, 'p');
		this.statusDomNode.className = 'ash-configuration-setting-description';
		this.statusDomNode.setAttribute('role', 'status');
		copy.append(this.titleDomNode, this.descriptionDomNode, this.statusDomNode);
		const controls = h(document, 'div');
		controls.className = 'ash-search-settings-controls';
		this.engine = this._register(new SelectBox(controls, { options: [{ value: 'tgrep', label: localize({ bundle: 'ash.settings', key: 'search.default' }, 'tgrep (default)') }, { value: 'ripgrep', label: 'ripgrep' }], ariaLabel: localize({ bundle: 'ash.settings', key: 'search.engine' }, 'Search engine'), presentation: 'field', contextViewProvider: contextView }));
		this.refreshButton = this._register(new Button(controls, { label: localize({ bundle: 'ash.settings', key: 'search.refresh' }, 'Refresh'), presentation: 'secondary' }));
		this.rowDomNode.append(copy, controls);
		this._register(this.engine.onDidSelect(({ value }) => { void this.configure(value as ContentSearchEngine); }));
		this._register(this.refreshButton.onDidClick(() => { void this.refresh(); }));
		this._register(remote.onDidChangeConnectionState(state => {
			if (state !== 'connected') { this.invalidate(); }
			else if (this.visible && !this.snapshot) { void this.refresh(); }
		}));
		this._register(remote.onDidChangeConnection(() => {
			this.invalidate();
			if (this.visible) { void this.refresh(); }
		}));
		const updateHint = (): void => {
			const hint = accessibleView.getOpenAriaHint(AccessibilityVerbositySettingId.ContentSearchSettings);
			if (hint) { this.rowDomNode.setAttribute('aria-description', hint); }
			else { this.rowDomNode.removeAttribute('aria-description'); }
		};
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(AccessibilityVerbositySettingId.ContentSearchSettings)) { updateHint(); }
		}));
		const scope = this._register(contextKeys.createScoped(this.rowDomNode));
		scope.createKey('contentSearchSettingsFocused', true);
		this._register(AccessibleViewRegistry.register({
			type: AccessibleViewType.Help, priority: 110, name: `content-search-settings-${generateUuid()}`,
			when: ContextKeyExpr.has('contentSearchSettingsFocused'),
			getProvider: () => {
				const focused = document.activeElement;
				if (!this.visible || !isHTMLElement(focused) || !this.rowDomNode.contains(focused)) { return undefined; }
				return new AccessibleContentProvider(AccessibleViewProviderId.ContentSearchSettings, { type: AccessibleViewType.Help },
					() => localize({ bundle: 'ash.settings', key: 'search.help' }, 'Content search settings\nUse Tab to reach Search engine and Refresh. Open Search engine with Enter or Space, use the arrow keys to choose tgrep or ripgrep, and press Enter to save. tgrep is the default. The selected engine is shared by Agent, editor and Codebase content searches. Refresh reads the backend configuration. If saving fails, refresh before trying again. Press Escape to close help and return to the control.'),
					() => focused.focus(), AccessibilityVerbositySettingId.ContentSearchSettings);
			},
		}));
		updateHint();
		this.render();
	}

	public getNodes(): readonly SettingsTreeNode<ISetting | SettingsContentItem>[] {
		return [{
			element: { kind: 'group', id: 'general.content-search', title: localize({ bundle: 'ash.settings', key: 'search.group' }, 'Content search'), description: '' },
			children: [{
				element: {
					kind: 'item', id: 'grep.backend', title: localize({ bundle: 'ash.settings', key: 'search.engine' }, 'Search engine'),
					description: localize({ bundle: 'ash.settings', key: 'search.description' }, 'Choose the content search engine shared by Agent, editor and Codebase. tgrep is the default; select ripgrep to use rg.'),
					keywords: ['tgrep', 'ripgrep', 'rg', 'grep', 'backend', 'content search'], value: { domNode: this.rowDomNode },
				}
			}],
		}];
	}

	public setVisible(visible: boolean): void {
		if (this.visible === visible) { return; }
		this.visible = visible;
		if (visible && !this.busy) { void this.refresh(); }
	}

	private invalidate(): void {
		this.version++;
		this.snapshot = undefined;
		this.busy = false;
		this.state = 'disconnected';
		this.render();
	}

	private async refresh(): Promise<void> {
		if (this.busy) { return; }
		const version = ++this.version;
		this.busy = true;
		this.state = 'loading';
		this.render();
		try {
			const snapshot = await this.search.read();
			if (this.isDisposed || version !== this.version) { return; }
			this.snapshot = snapshot;
			this.state = 'ready';
		} catch {
			if (this.isDisposed || version !== this.version) { return; }
			this.snapshot = undefined;
			this.state = 'readFailed';
		} finally {
			if (!this.isDisposed && version === this.version) { this.busy = false; this.render(); }
		}
	}

	private async configure(engine: ContentSearchEngine): Promise<void> {
		if (!this.snapshot || this.busy || this.snapshot.engine === engine) { return; }
		const version = ++this.version;
		this.busy = true;
		this.state = 'saving';
		this.render();
		try {
			await this.search.configure(engine, this.snapshot.revision);
			if (this.isDisposed || version !== this.version) { return; }
			const snapshot = await this.search.read();
			if (this.isDisposed || version !== this.version) { return; }
			this.snapshot = snapshot;
			this.state = 'saved';
		} catch {
			if (this.isDisposed || version !== this.version) { return; }
			this.snapshot = undefined;
			this.state = 'saveFailed';
		} finally {
			if (!this.isDisposed && version === this.version) { this.busy = false; this.render(); }
		}
	}

	private render(): void {
		const item = this.getNodes()[0].children![0].element;
		this.titleDomNode.textContent = item.title;
		this.descriptionDomNode.textContent = item.description;
		this.engine.value = this.snapshot?.engine;
		this.engine.enabled = !!this.snapshot && !this.busy;
		this.refreshButton.label = localize({ bundle: 'ash.settings', key: 'search.refresh' }, 'Refresh');
		this.refreshButton.enabled = !this.busy;
		this.rowDomNode.setAttribute('aria-busy', String(this.busy));
		switch (this.state) {
			case 'ready': this.statusDomNode.textContent = ''; break;
			case 'loading': this.statusDomNode.textContent = localize({ bundle: 'ash.settings', key: 'search.loading' }, 'Reading search configuration…'); break;
			case 'saving': this.statusDomNode.textContent = localize({ bundle: 'ash.settings', key: 'search.saving' }, 'Saving search engine…'); break;
			case 'saved': this.statusDomNode.textContent = localize({ bundle: 'ash.settings', key: 'search.saved' }, 'Search engine saved.'); break;
			case 'readFailed': this.statusDomNode.textContent = localize({ bundle: 'ash.settings', key: 'search.readFailed' }, 'Could not read search configuration. Connect to App Server and refresh.'); break;
			case 'saveFailed': this.statusDomNode.textContent = localize({ bundle: 'ash.settings', key: 'search.saveFailed' }, 'Could not save search engine. Refresh the configuration before trying again.'); break;
			case 'disconnected': this.statusDomNode.textContent = localize({ bundle: 'ash.settings', key: 'search.disconnected' }, 'App Server is disconnected.'); break;
		}
	}
}
