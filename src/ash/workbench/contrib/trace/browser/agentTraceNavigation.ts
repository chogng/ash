import { h } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope } from '../../../../platform/storage/common/storage.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ViewPane, type IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { readAgentTraceLocation, readLastAgentTraceResource } from '../common/trace.js';
import './agentTraceNavigation.css';

interface TraceNavigationCommands {
	readonly resume: string;
	readonly offline: string;
	readonly current?: string;
}

/** The shared sidebar borrows editor identity and opens commands; it owns no execution or capture model. */
export class AgentTraceNavigationView extends ViewPane {
	private readonly contextDomNode: HTMLElement;
	private readonly resumeButton: Button;
	constructor(private readonly navigation: TraceNavigationCommands, parent: HTMLElement, options: IViewPaneOptions,
		@ICommandService private readonly commands: ICommandService,
		@IEditorService private readonly editors: IEditorService,
		@IStorageService private readonly storage: IStorageService,
		@INotificationService private readonly notifications: INotificationService,
		@IContextKeyService contextKeys: IContextKeyService,
	) {
		super(parent, options);
		this.contentElement.classList.add('ash-agent-trace-navigation-view');
		this._register(contextKeys.createScoped(this.contentElement)).createKey('agentTraceNavigationFocused', true);
		this.contextDomNode = h(parent.ownerDocument, 'p', { className: 'ash-agent-trace-navigation-context', attributes: { 'aria-live': 'polite' } });
		this.contentElement.append(this.contextDomNode);
		this.resumeButton = this._register(new Button(this.contentElement, { label: localize('agentTrace.resume', 'Resume execution trace'), presentation: 'secondary', onClick: () => { void this.open(this.navigation.resume); } }));
		if (navigation.current) {
			this._register(new Button(this.contentElement, { label: localize('agentTrace.current', 'View current conversation'), presentation: 'secondary', onClick: () => { void this.open(navigation.current!); } }));
		}
		this._register(new Button(this.contentElement, { label: localize('agentTrace.offline', 'Open offline capture'), presentation: 'secondary', onClick: () => { void this.open(this.navigation.offline); } }));
		this._register(editors.onDidActiveEditorChange(() => this.updateContext()));
		this._register(storage.onDidChangeValue(event => { if (event.scope === StorageScope.WORKSPACE && event.key === 'agentTrace.lastResource') { this.updateContext(); } }));
		this.updateContext();
	}

	public override setVisible(visible: boolean): void {
		const opening = visible && !this.isVisible();
		super.setVisible(visible);
		if (!opening) { return; }
		this.updateContext();
		// Sessions opens its retained editor before the sidebar; Workbench container activation opens it here.
		if (this.editors.activeEditor?.resource.scheme !== 'ash-agent-trace') { void this.open(this.navigation.resume); }
	}

	public focus(): void { this.resumeButton.focus(); }

	private async open(command: string): Promise<void> {
		try { await this.commands.executeCommand(command); }
		catch (error) { this.notifications.error(String(error)); }
	}

	private updateContext(): void {
		const active = this.editors.activeEditor?.resource;
		const resource = active?.scheme === 'ash-agent-trace' ? active : readLastAgentTraceResource(this.storage);
		const location = resource ? readAgentTraceLocation(resource) : undefined;
		this.contextDomNode.textContent = location
			? localize('agentTrace.navigationContext', 'Viewing Session {0} · Thread {1} · Turn {2}', location.sessionId, location.threadId ?? '—', location.turnId ?? '—')
			: localize('agentTrace.offlineContext', 'Offline capture. Choose Import in Trace to load a saved file.');
	}
}
