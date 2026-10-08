import './media/agentCapabilitiesSettings.css';
import { h } from '../../../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import type { AgentCapabilitiesSnapshot, AgentToolCapability, IAgentCapabilitiesService } from '../../../../platform/agentCapabilities/common/agentCapabilitiesService.js';
import { dirPermissionNames, type DirPermissionsEntry, type IDirPermissionsService } from '../../../../platform/dirPermissions/common/dirPermissionsService.js';
import type { ILocalizationService } from '../../../services/localization/common/localizationService.js';
import type { IRemoteAgentService } from '../../../services/remote/common/remoteAgentService.js';

type View = 'tools' | 'sandbox';

/** Read-only Workbench view of the App Server's current tool catalog and directory grants. */
export class AgentCapabilitiesSettings extends Disposable {
	public readonly domNode: HTMLElement;
	private readonly status: HTMLParagraphElement;
	private readonly content: HTMLElement;
	private view: View | undefined;
	private catalog: AgentCapabilitiesSnapshot | undefined;
	private directories: readonly DirPermissionsEntry[] = [];
	private loadVersion = 0;

	constructor(container: HTMLElement, private readonly capabilities: IAgentCapabilitiesService, remoteAgentService: IRemoteAgentService, private readonly dirPermissions: IDirPermissionsService, private readonly localization: ILocalizationService) {
		super();
		const document = container.ownerDocument;
		this.domNode = h(document, 'section');
		this.domNode.className = 'ash-agent-capabilities-settings';
		this.domNode.hidden = true;
		this.status = h(document, 'p');
		this.status.className = 'ash-agent-capabilities-status';
		this.status.setAttribute('role', 'status');
		this.status.setAttribute('aria-live', 'polite');
		this.content = h(document, 'div');
		this.domNode.append(this.status, this.content);
		container.append(this.domNode);
		this._register(this.dirPermissions.onDidChangePermissions(() => {
			if (this.view === 'sandbox') void this.refresh();
		}));
		this._register(remoteAgentService.onDidChangeConnectionState(state => {
			if (state === 'connected' && this.view) void this.refresh();
			if (state !== 'connected') {
				this.loadVersion++;
				this.catalog = undefined;
				this.directories = [];
				this.status.textContent = this.label('capabilities.disconnected', 'App Server is disconnected.');
				this.render();
			}
		}));
	}

	public setView(view: View | undefined): void {
		if (this.view === view) return;
		this.view = view;
		this.domNode.hidden = view === undefined;
		if (view) void this.refresh();
	}

	private async refresh(): Promise<void> {
		const version = ++this.loadVersion;
		const view = this.view;
		this.status.textContent = this.label('capabilities.loading', 'Loading capabilities…');
		try {
			const catalog = await this.capabilities.read();
			const directories = view === 'sandbox' && catalog.directoryGrantsReadable ? await this.dirPermissions.list() : undefined;
			if (version !== this.loadVersion || !this.view) return;
			this.catalog = catalog;
			if (directories) this.directories = directories.entries;
			this.status.textContent = '';
			this.render();
		} catch {
			if (version !== this.loadVersion || !this.view) return;
			this.status.textContent = this.label('capabilities.failed', 'Could not load agent capabilities.');
			this.content.replaceChildren();
		}
	}

	private render(): void {
		this.content.replaceChildren();
		if (!this.view || !this.catalog) return;
		if (this.view === 'tools') this.renderTools(this.catalog.tools);
		else this.renderSandbox(this.catalog);
	}

	private renderTools(tools: readonly AgentToolCapability[]): void {
		this.addNote(this.label('capabilities.tools.note', 'This tool catalog was read when you opened this category. Return to Tools to refresh it. Each call is checked against its arguments, directory grants, and action policy.'));
		if (tools.length === 0) {
			this.addNote(this.label('capabilities.tools.empty', 'No tools are registered.'));
			return;
		}
		const list = h(this.content.ownerDocument, 'ul');
		list.className = 'ash-agent-capabilities-list';
		for (const tool of tools) {
			const item = h(this.content.ownerDocument, 'li');
			const name = h(this.content.ownerDocument, 'h4');
			name.textContent = tool.name;
			const description = h(this.content.ownerDocument, 'p');
			description.textContent = tool.description;
			const metadata = h(this.content.ownerDocument, 'p');
			metadata.className = 'ash-agent-capabilities-metadata';
			const source = tool.sourceDetails.join(' › ');
			metadata.textContent = `${this.sourceLabel(tool.source)} (${source}) · ${this.authorityLabel(tool.authority)} · ${this.exposureLabel(tool.exposure)}`;
			item.append(name, description, metadata);
			list.append(item);
		}
		this.content.append(list);
	}

	private renderSandbox(catalog: AgentCapabilitiesSnapshot): void {
		this.addNote(this.label('capabilities.sandbox.note', 'The process sandbox is selected for each command. Its policy controls filesystem writes, visible directories, and network access; the backend can reject a request before launch.'));
		this.addNote(catalog.localProcessSandboxConfigured
			? `${this.label('capabilities.sandbox.backends', 'Configured backend candidates:')} ${catalog.sandboxBackends.join(', ')}`
			: this.label('capabilities.sandbox.unavailable', 'Local process execution is not configured in this environment.'));
		if (catalog.sandboxDiagnostics.length) {
			this.addNote(this.label('capabilities.sandbox.preflight', 'Read-only process preparation checks for the current directory. Each command and terminal is checked again before launch.'));
			const networkLabels = {
				denied: this.label('capabilities.sandbox.network.denied', 'Network denied'),
				allowed: this.label('capabilities.sandbox.network.allowed', 'Network allowed'),
				managed: this.label('capabilities.sandbox.network.managed', 'Managed network'),
			};
			const readinessLabels = {
				ready: this.label('capabilities.sandbox.ready', 'Preparation passed'),
				unsupported: this.label('capabilities.sandbox.unsupported', 'Policy unsupported'),
				unavailable: this.label('capabilities.sandbox.backendUnavailable', 'Backend unavailable'),
			};
			const list = h(this.content.ownerDocument, 'ul');
			for (const diagnostic of catalog.sandboxDiagnostics) {
				const item = h(this.content.ownerDocument, 'li');
				const reason = diagnostic.readiness.type === 'ready' ? '' : `: ${diagnostic.readiness.reason}`;
				item.textContent = `${diagnostic.backend} · ${networkLabels[diagnostic.network]} · ${readinessLabels[diagnostic.readiness.type]}${reason}`;
				list.append(item);
			}
			this.content.append(list);
		}
		const heading = h(this.content.ownerDocument, 'h4');
		heading.textContent = this.label('capabilities.sandbox.directories', 'Configured directory grants');
		this.content.append(heading);
		if (!catalog.directoryGrantsReadable) {
			this.addNote(this.label('capabilities.sandbox.hostOnly', 'Directory grants can only be inspected by the desktop host.'));
			return;
		}
		this.addNote(this.label('capabilities.sandbox.directoryNote', 'These saved grants are an upper bound. A session can use a narrower selection, and each tool checks its requested path.'));
		if (this.directories.length === 0) {
			this.addNote(this.label('capabilities.sandbox.noDirectories', 'No directory grants are configured.'));
			return;
		}
		const list = h(this.content.ownerDocument, 'ul');
		list.className = 'ash-agent-capabilities-list';
		for (const directory of this.directories) {
			const item = h(this.content.ownerDocument, 'li');
			const path = h(this.content.ownerDocument, 'h5');
			path.textContent = directory.path ?? directory.dir;
			const permissions = h(this.content.ownerDocument, 'p');
			permissions.textContent = directory.permissions.map(permission => this.label(`capabilities.permission.${permission}`, dirPermissionNames[permission])).join(', ');
			item.append(path, permissions);
			list.append(item);
		}
		this.content.append(list);
	}

	private addNote(message: string): void {
		const note = h(this.content.ownerDocument, 'p');
		note.className = 'ash-agent-capabilities-note';
		note.textContent = message;
		this.content.append(note);
	}

	private authorityLabel(authority: AgentToolCapability['authority']): string {
		const labels = {
			directoryRead: this.label('capabilities.authority.directoryRead', 'Directory read'),
			directoryWrite: this.label('capabilities.authority.directoryWrite', 'Directory write'),
			processExecution: this.label('capabilities.authority.processExecution', 'Process execution'),
			productService: this.label('capabilities.authority.productService', 'Product service'),
			providerDefined: this.label('capabilities.authority.providerDefined', 'Provider-defined scope'),
		};
		return labels[authority];
	}

	private sourceLabel(source: AgentToolCapability['source']): string {
		const labels = {
			environment: this.label('capabilities.source.environment', 'Execution environment'),
			dynamic: this.label('capabilities.source.dynamic', 'Client tool'),
			extension: this.label('capabilities.source.extension', 'Extension'),
			host: this.label('capabilities.source.host', 'Product host'),
			local: this.label('capabilities.source.local', 'Built-in directory tool'),
			mcp: this.label('capabilities.source.mcp', 'MCP server'),
		};
		return labels[source];
	}

	private exposureLabel(exposure: AgentToolCapability['exposure']): string {
		const labels = {
			direct: this.label('capabilities.exposure.direct', 'Direct'),
			deferred: this.label('capabilities.exposure.deferred', 'On search'),
			modelOnly: this.label('capabilities.exposure.modelOnly', 'Model only'),
			hidden: this.label('capabilities.exposure.hidden', 'Internal'),
		};
		return labels[exposure];
	}

	private label(key: string, fallback: string): string {
		return this.localization.translate('ash.settings', key, fallback);
	}
}
