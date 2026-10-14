import './media/agentCapabilitiesSettings.css';
import { h } from '../../../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import type { AgentCapabilitiesSnapshot, IAgentCapabilitiesService } from '../../../../platform/agentCapabilities/common/agentCapabilitiesService.js';
import { workspaceTrustPermissionNames, type WorkspaceTrustEntry, type IWorkspaceTrustApi } from '../../../../platform/workspace/common/workspaceTrust.js';
import type { ILocalizationService } from '../../../services/localization/common/localizationService.js';
import type { IAppServerRemoteAgentService } from '../../../services/remote/common/appServerRemoteAgentService.js';

type View = 'sandbox';

/** Read-only Workbench view of process isolation and directory grants. */
export class AgentCapabilitiesSettings extends Disposable {
	public readonly domNode: HTMLElement;
	private readonly status: HTMLParagraphElement;
	private readonly content: HTMLElement;
	private view: View | undefined;
	private catalog: AgentCapabilitiesSnapshot | undefined;
	private directories: readonly WorkspaceTrustEntry[] = [];
	private loadVersion = 0;

	constructor(
		container: HTMLElement,
		private readonly capabilities: IAgentCapabilitiesService,
		remoteAgentService: IAppServerRemoteAgentService,
		private readonly workspaceTrust: IWorkspaceTrustApi,
		private readonly localization: ILocalizationService,
	) {
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
		this._register(toDisposable(() => {
			this.loadVersion++;
			this.view = undefined;
			this.catalog = undefined;
			this.directories = [];
		}));
		this._register(this.workspaceTrust.onDidChangeTrust(() => {
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
			const catalog = view === 'sandbox' ? await this.capabilities.read() : undefined;
			const directories = catalog?.directoryGrantsReadable ? await this.workspaceTrust.listDirectories() : undefined;
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
		if (this.view === 'sandbox' && this.catalog) this.renderSandbox(this.catalog);
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
			permissions.textContent = directory.permissions.map(permission => this.label(`capabilities.permission.${permission}`, workspaceTrustPermissionNames[permission])).join(', ');
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

	private label(key: string, fallback: string): string {
		return this.localization.translate('ash.settings', key, fallback);
	}
}
