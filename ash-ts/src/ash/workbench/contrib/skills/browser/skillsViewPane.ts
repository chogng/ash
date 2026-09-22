import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { DialogSeverity, IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IMarketplaceService, OPEN_MARKETPLACE_COMMAND_ID } from '../../../../platform/marketplace/common/marketplaceService.js';
import { ISkillService, type SkillManagementSnapshot } from '../../../../platform/skills/common/skillService.js';
import { ViewPane, type IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import './skills.css';

export class SkillsViewPane extends ViewPane {
	private readonly list: HTMLSelectElement;
	private readonly detail: HTMLPreElement;
	private readonly diagnostics: HTMLPreElement;
	private readonly status: HTMLDivElement;
	private readonly toggle: HTMLButtonElement;
	private snapshot: SkillManagementSnapshot | undefined;
	private working = false;
	private generation = 0;

	constructor(container: HTMLElement, options: IViewPaneOptions,
		@ISkillService private readonly skills: ISkillService,
		@IMarketplaceService marketplace: IMarketplaceService,
		@ICommandService private readonly commands: ICommandService,
		@IDialogService private readonly dialogs: IDialogService,
		@IConfigurationService private readonly configuration: IConfigurationService,
	) {
		super(container, options);
		const document = container.ownerDocument;
		this.contentElement.classList.add('ash-skills');
		const actions = h(document, 'div'); actions.className = 'skills-actions';
		actions.append(this.button('Get skills from Marketplace', async () => { await this.commands.executeCommand(OPEN_MARKETPLACE_COMMAND_ID, { capabilityKind: 'skill' }); }), this.button('Refresh', () => this.load()), this.button('Help', () => this.showHelp()));
		this.list = h(document, 'select'); this.list.size = 8;
		const label = h(document, 'label'); const caption = h(document, 'span'); caption.id = generateUuid(); caption.textContent = 'Skills'; this.list.setAttribute('aria-labelledby', caption.id); label.append(caption, this.list);
		this.detail = h(document, 'pre'); this.detail.tabIndex = 0; this.detail.setAttribute('aria-label', 'Skill details');
		this.diagnostics = h(document, 'pre'); this.diagnostics.tabIndex = 0; this.diagnostics.setAttribute('aria-label', 'Skill diagnostics');
		this.status = h(document, 'div'); this.status.setAttribute('role', 'status');
		this.toggle = this.button('Enable skill', () => this.setEnabled());
		this.contentElement.append(actions, label, this.detail, this.toggle, this.status, this.diagnostics);
		this._register(addDisposableListener(this.list, 'change', () => this.select()));
		this._register(addDisposableListener(this.contentElement, 'keydown', event => { if (event.altKey && event.key === 'F1') { event.preventDefault(); void this.showHelp(); } }));
		this._register(marketplace.onDidChangeInstalled(() => { this.snapshot = undefined; if (this.isVisible() && !this.working) { void this.run(() => this.load()); } }));
		this.applyEnabled();
	}
	public override setVisible(visible: boolean): void { super.setVisible(visible); if (visible && !this.snapshot) { void this.run(() => this.load()); } }
	public override focus(): void {
		this.list.focus();
		if (this.configuration.getValue<boolean>('accessibility.verbosity.skills')) { this.status.textContent = 'Skills. Use arrow keys to select a skill, Tab to navigate, and Alt+F1 for help.'; }
	}
	private async load(): Promise<void> {
		const generation = ++this.generation;
		const snapshot = await this.skills.read();
		if (this.isDisposed || generation !== this.generation) { return; }
		const current = this.list.value;
		this.snapshot = snapshot;
		this.list.replaceChildren(...snapshot.catalog.skills.map(skill => {
			const option = h(this.element.ownerDocument, 'option'); option.value = JSON.stringify(skill.id); option.textContent = `${skill.id.name} · ${skill.id.source} · ${skill.enabled ? 'Enabled' : 'Disabled'}`; return option;
		}));
		this.list.value = snapshot.catalog.skills.some(skill => JSON.stringify(skill.id) === current) ? current : this.list.options[0]?.value ?? '';
		this.diagnostics.textContent = snapshot.diagnostics.length ? snapshot.diagnostics.map(entry => `${entry.source}${entry.subject ? ` / ${entry.subject}` : ''}: ${entry.message}`).join('\n') : 'No skill diagnostics.';
		this.status.textContent = `${snapshot.catalog.skills.length} skills. Invoke enabled skills with $name in chat.`;
		this.select();
	}
	private select(): void {
		const skill = this.snapshot?.catalog.skills.find(skill => JSON.stringify(skill.id) === this.list.value);
		this.detail.textContent = skill ? `${skill.id.name}\nSource: ${skill.id.source}\n${skill.description}\n${skill.compatible ? 'Compatible' : 'Compatibility unknown'}` : '';
		this.toggle.textContent = skill?.enabled ? 'Disable skill' : 'Enable skill';
		this.applyEnabled();
	}
	private async setEnabled(): Promise<void> {
		const snapshot = this.snapshot;
		const skill = snapshot?.catalog.skills.find(skill => JSON.stringify(skill.id) === this.list.value);
		if (!snapshot || !skill || this.working) { return; }
		this.working = true; this.applyEnabled();
		try { await this.skills.setEnabled(skill.id, !skill.enabled, snapshot.revision); if (!this.isDisposed) { await this.load(); } }
		finally { this.working = false; if (!this.isDisposed) { this.applyEnabled(); this.toggle.focus(); } }
	}
	private applyEnabled(): void {
		for (const control of this.contentElement.querySelectorAll<HTMLButtonElement | HTMLSelectElement>('button, select')) { control.disabled = this.working; }
		this.toggle.disabled = this.working || !this.snapshot || !this.list.value;
		this.contentElement.setAttribute('aria-busy', String(this.working));
	}
	private async run(action: () => Promise<void>): Promise<void> { try { await action(); } catch (error) { if (!this.isDisposed) { this.status.textContent = error instanceof Error ? error.message : String(error); } } }
	private async showHelp(): Promise<void> {
		const focus = this.element.ownerDocument.activeElement;
		await this.dialogs.showMessage({ title: 'Skills help', severity: DialogSeverity.Info, message: 'This view loads skill metadata and diagnostics. Select a skill by name and source to enable or disable it. Use $name in chat to invoke an enabled skill. Get skills opens Marketplace, including skills bundled in Plugins. Package installation and removal are managed there. If configuration changes elsewhere, refresh before changing enablement again. Use Tab and Shift+Tab to navigate, arrow keys to select a skill, and Escape to close help.' });
		if (focus instanceof HTMLElement && focus.isConnected) { focus.focus(); }
	}
	private button(label: string, action: () => Promise<void>): HTMLButtonElement {
		const button = h(this.element.ownerDocument, 'button'); button.type = 'button'; button.textContent = label;
		this._register(addDisposableListener(button, 'click', () => { void this.run(action); })); return button;
	}
}
