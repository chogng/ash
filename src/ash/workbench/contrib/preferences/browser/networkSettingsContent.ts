import './media/networkSettingsContent.css';
import { h, isHTMLElement } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { SelectBox } from '../../../../base/browser/ui/selectbox/selectbox.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { INetworkDiagnosticsService, type HttpCompatibilityMode, type NetworkDiagnostics, type NetworkFailure, type NetworkSnapshot, type NetworkTarget } from '../../../../platform/networkDiagnostics/common/networkDiagnosticsService.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ILocalizationService } from '../../../services/localization/common/localizationService.js';
import type { ISetting } from '../../../services/preferences/common/preferences.js';
import { IAppServerRemoteAgentService } from '../../../services/remote/common/appServerRemoteAgentService.js';
import type { SettingsContent, SettingsContentItem, SettingsTreeNode } from './settingsTreeModels.js';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.NetworkSettings,
	defaultValue: true,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') { throw new TypeError('Network accessibility verbosity must be boolean'); }
		return value;
	},
	setting: {
		valueType: 'boolean',
		get title() { return localize('network.verbosity', 'Network accessibility help'); },
		get description() { return localize('network.verbosityDescription', 'Announce how to open accessibility help in network settings.'); },
	},
});

/** Workbench presents backend transport settings without copying them into frontend settings.json. */
export class NetworkSettingsContent extends Disposable implements SettingsContent {
	public readonly categoryId = 'network';
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChange = this.changed.event;
	private readonly protocol: SelectBox;
	private readonly protocolControls: HTMLElement;
	private readonly domains: HTMLElement;
	private readonly domainList: HTMLElement;
	private readonly copy: Button;
	private readonly show: Button;
	private readonly refreshButton: Button;
	private readonly diagnostics: HTMLElement;
	private readonly runButton: Button;
	private readonly status: HTMLElement;
	private readonly results: HTMLElement;
	private readonly rowLabels = new Map<HTMLElement, { title: HTMLElement; description: HTMLElement; }>();
	private statusMessage: { key: string; text: string; } | undefined;
	private snapshot: NetworkSnapshot | undefined;
	private report: NetworkDiagnostics | undefined;
	private visible = false;
	private showDomains = false;
	private busy = false;
	private version = 0;

	constructor(container: HTMLElement,
		@INetworkDiagnosticsService private readonly network: INetworkDiagnosticsService,
		@IClipboardService private readonly clipboard: IClipboardService,
		@IAppServerRemoteAgentService remote: IAppServerRemoteAgentService,
		@ILocalizationService localization: ILocalizationService,
		@IConfigurationService configuration: IConfigurationService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IAccessibleViewService accessibleView: IAccessibleViewService,
	) {
		super();
		const document = container.ownerDocument;
		this.protocolControls = h(document, 'div');
		this.protocolControls.className = 'ash-network-settings';
		this.protocol = this._register(new SelectBox(this.protocolControls, { options: [], ariaLabel: localize('network.http.title', 'HTTP compatibility mode') }));
		this.protocol.enabled = false;
		this._register(this.protocol.onDidSelect(({ value }) => { void this.configure(value as HttpCompatibilityMode); }));
		this.domains = h(document, 'div');
		this.domains.className = 'ash-network-settings';
		const actions = h(document, 'div');
		actions.className = 'ash-network-settings-actions';
		this.copy = this._register(new Button(actions, { label: localize('network.copy', 'Copy domains'), presentation: 'secondary' }));
		this.show = this._register(new Button(actions, { label: localize('network.show', 'Show'), presentation: 'secondary' }));
		this.refreshButton = this._register(new Button(actions, { label: localize('network.refresh', 'Refresh'), presentation: 'secondary' }));
		this.domainList = h(document, 'div');
		this.domainList.className = 'ash-network-settings-details';
		this.domainList.id = `ash-network-domains-${generateUuid()}`;
		this.domainList.hidden = true;
		this.show.domNode.setAttribute('aria-controls', this.domainList.id);
		this.show.domNode.setAttribute('aria-expanded', 'false');
		this.domains.append(actions, this.domainList);
		this._register(this.copy.onDidClick(() => { void this.copyDomains(); }));
		this._register(this.show.onDidClick(() => {
			this.showDomains = !this.showDomains;
			this.render();
		}));
		this._register(this.refreshButton.onDidClick(() => { void this.refresh(); }));
		this.diagnostics = h(document, 'div');
		this.diagnostics.className = 'ash-network-settings';
		this.runButton = this._register(new Button(this.diagnostics, { label: localize('network.run', 'Run diagnostic'), presentation: 'secondary' }));
		this._register(this.runButton.onDidClick(() => { void this.run(); }));
		this.status = h(document, 'p');
		this.status.setAttribute('role', 'status');
		this.status.setAttribute('aria-live', 'polite');
		this.results = h(document, 'ul');
		this.results.className = 'ash-network-settings-results';
		this.diagnostics.append(this.status, this.results);
		for (const row of [this.protocolControls, this.domains, this.diagnostics]) {
			const title = h(document, 'h5');
			const description = h(document, 'p');
			description.className = 'ash-network-settings-description';
			row.prepend(title, description);
			this.rowLabels.set(row, { title, description });
		}
		this._register(remote.onDidChangeConnectionState(state => {
			if (state !== 'connected') { this.invalidate(); }
			else if (this.visible && !this.snapshot) { void this.refresh(); }
		}));
		this._register(remote.onDidChangeConnection(() => {
			this.invalidate();
			if (this.visible) { void this.refresh(); }
		}));
		const updateHints = (): void => {
			const hint = accessibleView.getOpenAriaHint(AccessibilityVerbositySettingId.NetworkSettings);
			for (const element of [this.protocolControls, this.domains, this.diagnostics]) {
				if (hint) { element.setAttribute('aria-description', hint); }
				else { element.removeAttribute('aria-description'); }
			}
		};
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(AccessibilityVerbositySettingId.NetworkSettings)) { updateHints(); }
		}));
		for (const element of [this.protocolControls, this.domains, this.diagnostics]) {
			const scope = this._register(contextKeys.createScoped(element));
			scope.createKey('networkSettingsFocused', true);
		}
		for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
			this._register(AccessibleViewRegistry.register({
				type, priority: 110, name: `network-settings-${generateUuid()}-${type}`, when: ContextKeyExpr.has('networkSettingsFocused'),
				getProvider: () => {
					const focused = document.activeElement;
					if (!this.visible || !isHTMLElement(focused) || ![this.protocolControls, this.domains, this.diagnostics].some(element => element.contains(focused))) { return undefined; }
					return new AccessibleContentProvider(AccessibleViewProviderId.NetworkSettings, { type },
						() => type === AccessibleViewType.Help
							? localize('network.help', 'Network settings\nUse Tab to reach HTTP compatibility mode, Copy domains, Show, Refresh, and Run diagnostic. HTTP/2 negotiates the supported protocol; HTTP/1.1 restricts subsequent application HTTP requests. Existing requests continue. Show lists configured service hosts and routes. An HTTP response proves reachability, including 401 and 404; account checks are separate. Refresh reads the current backend configuration. Use the accessible view to read domains and diagnostic results.')
							: [this.snapshot ? (this.snapshot.httpMode === 'http1' ? 'HTTP/1.1' : 'HTTP/2') : '', ...this.snapshot?.targets.map(target => this.targetText(target)) ?? [], this.status.textContent, ...Array.from(this.results.children, element => element.textContent)].join('\n'),
						() => focused.focus(), AccessibilityVerbositySettingId.NetworkSettings);
				},
			}));
		}
		updateHints();
		this.render();
	}

	public getNodes(): readonly SettingsTreeNode<ISetting | SettingsContentItem>[] {
		return [{
			element: { kind: 'group', id: 'network.services', title: localize('network.group', 'Network'), description: '' },
			children: [
				{ element: { kind: 'item' as const, id: 'network.http', title: localize('network.http.title', 'HTTP compatibility mode'), description: localize('network.http.description', 'Prefer HTTP/2 for application HTTP requests. Select HTTP/1.1 for incompatible proxies or VPNs. Changes apply to subsequent requests; existing requests continue.'), keywords: ['HTTP/2', 'HTTP/1.1', 'proxy', 'VPN'], value: { domNode: this.protocolControls } } },
				{ element: { kind: 'item' as const, id: 'network.domains', title: localize('network.domains.title', 'Required domains'), description: localize('network.domains.description', 'Service hosts used by configured model connections and Ash services. Add them to your firewall or proxy allowlist.'), keywords: ['firewall', 'hosts', 'allowlist', 'domains'], value: { domNode: this.domains } } },
				{ element: { kind: 'item' as const, id: 'network.diagnostics', title: localize('network.diagnostics.title', 'Network diagnostics'), description: localize('network.diagnostics.description', 'Check connectivity through the application transport. HTTP reachability and signed-in account checks are reported separately.'), keywords: ['DNS', 'TLS', 'certificate', 'connectivity', 'diagnostic'], value: { domNode: this.diagnostics } } },
			].map(node => ({ ...node, element: { ...node.element, keywords: [...node.element.keywords, 'network', localize('network.group', 'Network')] } })),
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
		this.report = undefined;
		this.busy = false;
		this.setStatus('network.disconnected', 'App Server is disconnected.');
		this.render();
	}

	private async refresh(): Promise<void> {
		if (this.busy) { return; }
		const version = ++this.version;
		this.busy = true;
		this.setStatus('network.loading', 'Reading network configuration…');
		this.render();
		try {
			const snapshot = await this.network.read();
			if (this.isDisposed || version !== this.version) { return; }
			this.snapshot = snapshot;
			this.report = undefined;
			if (snapshot.targets.length) { this.statusMessage = undefined; this.status.textContent = ''; }
			else { this.setStatus('network.empty', 'No service hosts are configured.'); }
		} catch {
			if (this.isDisposed || version !== this.version) { return; }
			this.snapshot = undefined;
			this.report = undefined;
			this.setStatus('network.readFailed', 'Could not read network configuration. Connect to App Server and refresh.');
		} finally {
			if (!this.isDisposed && version === this.version) { this.busy = false; this.render(); }
		}
	}

	private async configure(mode: HttpCompatibilityMode): Promise<void> {
		if (!this.snapshot || this.busy) { return; }
		const version = ++this.version;
		this.busy = true;
		this.setStatus('network.saving', 'Saving HTTP compatibility mode…');
		this.render();
		try {
			await this.network.configureHttp(mode, this.snapshot.revision);
			const snapshot = await this.network.read();
			if (this.isDisposed || version !== this.version) { return; }
			this.snapshot = snapshot;
			this.report = undefined;
			this.setStatus('network.saved', 'HTTP compatibility mode saved. Subsequent requests use the selected mode.');
		} catch {
			if (this.isDisposed || version !== this.version) { return; }
			this.setStatus('network.saveFailed', 'Could not save HTTP compatibility mode. Refresh the configuration before trying again.');
		} finally {
			if (!this.isDisposed && version === this.version) { this.busy = false; this.render(); }
		}
	}

	private async run(): Promise<void> {
		if (!this.snapshot || this.busy) { return; }
		const version = ++this.version;
		this.busy = true;
		this.report = undefined;
		this.setStatus('network.running', 'Checking service connectivity…');
		this.render();
		try {
			const report = await this.network.run();
			if (this.isDisposed || version !== this.version) { return; }
			this.report = report;
			this.snapshot = report.network;
			this.setStatus('network.completed', 'Network diagnostic completed.');
		} catch {
			if (this.isDisposed || version !== this.version) { return; }
			this.setStatus('network.runFailed', 'Could not complete the network diagnostic.');
		} finally {
			if (!this.isDisposed && version === this.version) { this.busy = false; this.render(); }
		}
	}

	private async copyDomains(): Promise<void> {
		if (!this.snapshot) { return; }
		const version = this.version;
		try {
			await this.clipboard.writeText([...new Set(this.snapshot.targets.map(target => target.host))].sort().join('\n'));
			if (!this.isDisposed && version === this.version) { this.setStatus('network.copied', 'Domains copied.'); }
		} catch {
			if (!this.isDisposed && version === this.version) { this.setStatus('network.copyFailed', 'Could not copy domains.'); }
		}
	}

	private setStatus(key: string, text: string): void {
		this.statusMessage = { key, text };
		this.status.textContent = localize(key, text);
	}

	private render(): void {
		for (const node of this.getNodes()[0].children!) {
			if (node.element.kind === 'item' && 'domNode' in node.element.value) {
				const labels = this.rowLabels.get(node.element.value.domNode)!;
				labels.title.textContent = node.element.title;
				labels.description.textContent = node.element.description;
			}
		}
		if (this.statusMessage) { this.status.textContent = localize(this.statusMessage.key, this.statusMessage.text); }
		this.protocol.setOptions([{ value: 'http2', label: localize('network.http2', 'HTTP/2 (recommended)') }, { value: 'http1', label: 'HTTP/1.1' }]);
		this.protocol.value = this.snapshot?.httpMode ?? 'http2';
		this.protocol.enabled = this.copy.enabled = this.show.enabled = this.runButton.enabled = !!this.snapshot && !this.busy;
		this.refreshButton.enabled = !this.busy;
		this.copy.enabled = !!this.snapshot?.targets.length && !this.busy;
		this.copy.label = localize('network.copy', 'Copy domains');
		this.show.label = this.showDomains ? localize('network.hide', 'Hide') : localize('network.show', 'Show');
		this.show.domNode.setAttribute('aria-expanded', String(this.showDomains));
		this.domainList.hidden = !this.showDomains;
		this.refreshButton.label = localize('network.refresh', 'Refresh');
		this.runButton.label = localize('network.run', 'Run diagnostic');
		this.diagnostics.setAttribute('aria-busy', String(this.busy));
		this.domainList.replaceChildren();
		for (const target of this.snapshot?.targets ?? []) {
			const line = h(this.domains.ownerDocument, 'p');
			line.textContent = this.targetText(target);
			this.domainList.append(line);
		}
		this.results.replaceChildren();
		for (const check of this.report?.checks ?? []) {
			const line = h(this.results.ownerDocument, 'li');
			const target = this.report!.network.targets.find(target => target.id === check.targetId);
			const name = target ? this.targetText(target) : localize('network.account', '{0} account', check.connection);
			let outcome: string;
			switch (check.outcome.type) {
				case 'reachable': outcome = localize('network.reachable', 'Reachable (HTTP {0})', check.outcome.httpStatus); break;
				case 'accountAvailable': outcome = localize('network.accountAvailable', 'Account available'); break;
				case 'failed': outcome = this.failureText(check.outcome.failure); break;
			}
			line.textContent = `${name} — ${outcome}`;
			this.results.append(line);
		}
	}

	private targetText(target: NetworkTarget): string {
		const purposes = {
			model: localize('network.purpose.model', 'Model'), signIn: localize('network.purpose.signIn', 'Sign-in'),
			usage: localize('network.purpose.usage', 'Usage'), service: localize('network.purpose.service', 'Service'),
		};
		let route: string;
		switch (target.route.type) {
			case 'direct': route = localize('network.route.direct', 'Direct'); break;
			case 'blocked': route = localize('network.route.blocked', 'Blocked by policy'); break;
			case 'proxy': route = localize('network.route.proxy', 'Proxy {0}:{1}', target.route.host, target.route.port); break;
		}
		return localize('network.target', '{0}:{1} · {2} · {3} · {4}', target.host, target.port, target.displayName, purposes[target.purpose], route);
	}

	private failureText(failure: NetworkFailure): string {
		const failures: Record<NetworkFailure, string> = {
			dns: localize('network.failure.dns', 'DNS lookup failed'), proxy: localize('network.failure.proxy', 'Proxy connection failed'),
			tls: localize('network.failure.tls', 'TLS handshake failed'), certificateConfiguration: localize('network.failure.certificateConfiguration', 'Certificate configuration failed'),
			connect: localize('network.failure.connect', 'Connection failed'), timeout: localize('network.failure.timeout', 'Request timed out'),
			policy: localize('network.failure.policy', 'Blocked by network policy'), configuration: localize('network.failure.configuration', 'Invalid transport configuration'),
			request: localize('network.failure.request', 'Request failed'), authentication: localize('network.failure.authentication', 'Sign-in required'),
			accountChanged: localize('network.failure.accountChanged', 'Account changed during the check'), accountOperation: localize('network.failure.accountOperation', 'Account check failed'),
		};
		return failures[failure];
	}
}
