import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { DialogSeverity, IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ILanguageServerService, type LanguageServerSnapshot } from '../../../../platform/language/common/languageServerService.js';
import { IMarketplaceService, OPEN_MARKETPLACE_COMMAND_ID } from '../../../../platform/marketplace/common/marketplaceService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ViewPane, type IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ILanguageServerStatusService } from '../../../services/language/common/languageServerStatusService.js';
import './languageServers.css';

export class LanguageServersViewPane extends ViewPane {
	private readonly directory: HTMLSelectElement;
	private readonly language: HTMLInputElement;
	private readonly list: HTMLSelectElement;
	private readonly server: HTMLInputElement;
	private readonly enabled: HTMLInputElement;
	private readonly executable: HTMLInputElement;
	private readonly save: HTMLButtonElement;
	private readonly reset: HTMLButtonElement;
	private readonly status: HTMLDivElement;
	private readonly runtime: HTMLPreElement;
	private snapshot: LanguageServerSnapshot | undefined;
	private working = false;
	private generation = 0;

	constructor(container: HTMLElement, options: IViewPaneOptions,
		@ILanguageServerService private readonly servers: ILanguageServerService,
		@ILanguageServerStatusService private readonly states: ILanguageServerStatusService,
		@IMarketplaceService marketplace: IMarketplaceService,
		@ICommandService private readonly commands: ICommandService,
		@ICodeEditorService private readonly editors: ICodeEditorService,
		@IEditorService editorService: IEditorService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IDialogService private readonly dialogs: IDialogService,
		@IConfigurationService private readonly configuration: IConfigurationService,
	) {
		super(container, options);
		const document = container.ownerDocument;
		this.contentElement.classList.add('ash-language-servers');
		this.directory = h(document, 'select'); this.field('Workspace folder', this.directory);
		this.language = this.input('Language ID');
		this.contentElement.append(this.button('Find language servers in Marketplace', async () => {
			const languageId = this.language.value.trim();
			if (!languageId) { throw new Error('Open a code file or enter a language ID first.'); }
			await this.commands.executeCommand(OPEN_MARKETPLACE_COMMAND_ID, { languageId, capabilityKind: 'executable' });
		}));
		this.list = h(document, 'select'); this.list.size = 5; this.field('Language servers', this.list);
		this.server = this.input('Server ID');
		this.enabled = this.input('Enable server', 'checkbox');
		this.executable = this.input('Executable path (optional)');
		const actions = h(document, 'div'); actions.className = 'language-server-actions';
		this.save = this.button('Save server configuration', () => this.mutate(false));
		this.reset = this.button('Use default configuration', () => this.mutate(true));
		actions.append(this.save, this.reset, this.button('Refresh', () => this.load()), this.button('Help', () => this.showHelp()));
		this.status = h(document, 'div'); this.status.setAttribute('role', 'status');
		this.runtime = h(document, 'pre'); this.runtime.tabIndex = 0; this.runtime.setAttribute('aria-label', 'Server status');
		this.contentElement.append(actions, this.status, this.runtime);
		this._register(addDisposableListener(this.list, 'change', () => { this.server.value = this.list.value; this.select(); }));
		this._register(addDisposableListener(this.server, 'change', () => this.select()));
		this._register(addDisposableListener(this.directory, 'change', () => { void this.run(() => this.load()); }));
		this._register(addDisposableListener(this.contentElement, 'keydown', event => { if (event.altKey && event.key === 'F1') { event.preventDefault(); void this.showHelp(); } }));
		this._register(states.onDidChange(() => this.renderStatus()));
		this._register(marketplace.onDidChangeInstalled(() => { if (this.isVisible()) { this.status.textContent = 'Installed packages changed. Refresh to load available servers.'; } else { this.snapshot = undefined; } }));
		this._register(editorService.onDidActiveEditorChange(() => this.updateLanguage()));
		this._register(workspace.onDidChangeWorkspace(() => { this.snapshot = undefined; this.updateDirectories(); if (this.isVisible()) { void this.run(() => this.load()); } }));
		this.updateDirectories();
		this.applyEnabled();
	}

	public override setVisible(visible: boolean): void {
		super.setVisible(visible);
		if (visible) { this.updateLanguage(); if (!this.snapshot) { void this.run(() => this.load()); } }
	}
	public override focus(): void {
		this.updateLanguage(); this.language.focus();
		if (this.configuration.getValue<boolean>('accessibility.verbosity.languageServers')) { this.status.textContent = 'Language servers. Use Tab to navigate and Alt+F1 for help.'; }
	}
	private updateLanguage(): void {
		const model = this.editors.getActiveCodeEditor()?.getModel();
		if (model) { this.language.value = model.getLanguageId(); }
	}
	private updateDirectories(): void {
		const folders = this.workspace.getWorkspace().folders;
		this.directory.replaceChildren(...folders.map(folder => this.option(folder.name, folders.length === 1 ? '' : folder.id)));
		if (!folders.length) { this.directory.append(this.option('Current workspace', '')); }
	}
	private async load(): Promise<void> {
		const generation = ++this.generation;
		const snapshot = await this.servers.read(this.directory.value || undefined);
		if (this.isDisposed || generation !== this.generation) { return; }
		this.snapshot = snapshot;
		const ids = [...new Set([...Object.keys(snapshot.configurations), ...snapshot.servers.map(server => server.id)])].sort();
		this.list.replaceChildren(...ids.map(id => this.option(id, id)));
		this.list.value = ids.includes(this.server.value) ? this.server.value : ids[0] ?? '';
		this.server.value = this.list.value;
		this.select();
		this.status.textContent = snapshot.servers.length ? `${snapshot.servers.length} servers available. Servers start when a matching document needs them.` : 'No enabled server is available. Find a package in Marketplace or configure an executable.';
		this.applyEnabled();
	}
	private select(): void {
		const config = this.snapshot?.configurations[this.server.value];
		this.enabled.checked = config ? config.mode === 'enabled' : !!this.snapshot?.servers.some(server => server.id === this.server.value);
		this.executable.value = config?.executable ?? '';
		this.renderStatus(); this.applyEnabled();
	}
	private renderStatus(): void {
		const id = this.server.value;
		const languages = this.snapshot?.servers.find(server => server.id === id)?.languageIds;
		const state = this.states.getStates().find(state => state.server === id);
		const progress = this.states.getProgress().filter(progress => progress.server === id);
		this.runtime.textContent = [languages ? `Languages: ${languages.join(', ')}` : 'This server is not currently available.', state ? `${state.state}${state.message ? `: ${state.message}` : ''}` : 'No running session reported.', ...progress.map(item => `${item.title}${item.message ? `: ${item.message}` : ''}${item.percentage === undefined ? '' : ` (${item.percentage}%)`}`)].join('\n');
	}
	private async mutate(reset: boolean): Promise<void> {
		if (!this.snapshot || this.working) { return; }
		const id = this.server.value.trim();
		if (!id) { throw new Error('Enter a server ID.'); }
		this.working = true; this.applyEnabled();
		try {
			if (reset) { await this.servers.removeConfiguration(id, this.snapshot.revision); }
			else { await this.servers.configure(id, { mode: this.enabled.checked ? 'enabled' : 'disabled', executable: this.executable.value.trim() || undefined }, this.snapshot.revision); }
			if (!this.isDisposed) { await this.load(); }
		} finally { this.working = false; if (!this.isDisposed) { this.applyEnabled(); this.server.focus(); } }
	}
	private applyEnabled(): void {
		for (const control of this.contentElement.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input, select, button')) { control.disabled = this.working; }
		this.save.disabled = this.working || !this.snapshot;
		this.reset.disabled = this.working || !this.snapshot?.configurations[this.server.value];
		this.contentElement.setAttribute('aria-busy', String(this.working));
	}
	private async run(action: () => Promise<void>): Promise<void> {
		try { await action(); } catch (error) { if (!this.isDisposed) { this.status.textContent = error instanceof Error ? error.message : String(error); } }
	}
	private async showHelp(): Promise<void> {
		const focus = this.element.ownerDocument.activeElement;
		await this.dialogs.showMessage({ title: 'Language servers help', severity: DialogSeverity.Info, message: 'Language ID follows the active code editor and can be edited. Find language servers opens Marketplace filtered to executable routes for that exact language. Syntax-only packages are excluded. Choose a workspace folder to inspect server availability. Select a server or enter its ID to enable it or set an executable path on the App Server host. Leave the path empty to use the installed server or a server on PATH. Configuration applies to the profile. Use default removes the override; installed servers use their package defaults. If configuration changes elsewhere, refresh before saving again. Use Tab and Shift+Tab to navigate, arrow keys to select a server, and Escape to close help.' });
		if (focus instanceof HTMLElement && focus.isConnected) { focus.focus(); }
	}
	private option(label: string, value: string): HTMLOptionElement { const option = h(this.element.ownerDocument, 'option'); option.textContent = label; option.value = value; return option; }
	private field(text: string, control: HTMLElement): void {
		const label = h(this.element.ownerDocument, 'label'); const caption = h(this.element.ownerDocument, 'span'); caption.id = generateUuid(); caption.textContent = text;
		control.setAttribute('aria-labelledby', caption.id); label.append(caption, control); this.contentElement.append(label);
	}
	private input(label: string, type = 'text'): HTMLInputElement { const input = h(this.element.ownerDocument, 'input'); input.type = type; this.field(label, input); return input; }
	private button(label: string, action: () => Promise<void>): HTMLButtonElement {
		const button = h(this.element.ownerDocument, 'button'); button.type = 'button'; button.textContent = label;
		this._register(addDisposableListener(button, 'click', () => { void this.run(action); })); return button;
	}
}
