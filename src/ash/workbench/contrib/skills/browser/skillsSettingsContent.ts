import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { DialogSeverity, IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IMarketplaceService, OPEN_MARKETPLACE_COMMAND_ID } from '../../../../platform/marketplace/common/marketplaceService.js';
import { IPromptsService, type SkillManagementSnapshot } from '../../chat/common/promptSyntax/service/promptsService.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../base/common/event.js';
import { localize } from '../../../../nls.js';
import type { SettingsContent, SettingsContentItem, SettingsTreeNode } from '../../preferences/browser/settingsTreeModels.js';
import { IChatSessionNavigationService } from '../../../services/chat/common/chatSessionNavigationService.js';
import './skills.css';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: 'accessibility.verbosity.skills', defaultValue: true,
	parse: value => { if (typeof value !== 'boolean') { throw new TypeError('Skills accessibility verbosity must be boolean'); } return value; },
	setting: { valueType: 'boolean', title: localize('skills.verbosityTitle', 'Skills accessibility help'), description: localize('skills.verbosityDescription', 'Announce keyboard help when Skills receives focus.') },
});

export class SkillsSettingsContent extends Disposable implements SettingsContent {
	public readonly categoryId = 'skills';
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChange = this.changed.event;
	public readonly domNode: HTMLElement;
	private visible = false;
	private readonly list: HTMLSelectElement;
	private readonly detail: HTMLPreElement;
	private readonly diagnostics: HTMLPreElement;
	private readonly status: HTMLDivElement;
	private readonly toggle: HTMLButtonElement;
	private snapshot: SkillManagementSnapshot | undefined;
	private snapshotSessionId: string | undefined;
	private working = false;
	private generation = 0;

	constructor(container: HTMLElement,
		@IPromptsService private readonly skills: IPromptsService,
		@IMarketplaceService marketplace: IMarketplaceService,
		@ICommandService private readonly commands: ICommandService,
		@IDialogService private readonly dialogs: IDialogService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IChatSessionNavigationService private readonly sessions: IChatSessionNavigationService,
	) {
		super();
		const document = container.ownerDocument;
		this.domNode = h(document, 'section');
		this.domNode.className = 'ash-skills';
		this._register(toDisposable(() => this.domNode.remove()));
		const actions = h(document, 'div'); actions.className = 'skills-actions';
		actions.append(this.button(localize('skills.marketplace', 'Get skills from Marketplace'), async () => { await this.commands.executeCommand(OPEN_MARKETPLACE_COMMAND_ID, { capabilityKind: 'skill' }); }), this.button(localize('skills.refresh', 'Refresh'), () => this.load()), this.button(localize('skills.helpButton', 'Help'), () => this.showHelp()));
		this.list = h(document, 'select'); this.list.size = 8;
		const label = h(document, 'label'); const caption = h(document, 'span'); caption.id = generateUuid(); caption.textContent = localize('skills.title', 'Skills'); this.list.setAttribute('aria-labelledby', caption.id); label.append(caption, this.list);
		this.detail = h(document, 'pre'); this.detail.tabIndex = 0; this.detail.setAttribute('aria-label', localize('skills.details', 'Skill details'));
		this.diagnostics = h(document, 'pre'); this.diagnostics.tabIndex = 0; this.diagnostics.setAttribute('aria-label', localize('skills.diagnostics', 'Skill diagnostics'));
		this.status = h(document, 'div'); this.status.setAttribute('role', 'status');
		this.toggle = this.button(localize('skills.enable', 'Enable skill'), () => this.setEnabled());
		this.domNode.append(actions, label, this.detail, this.toggle, this.status, this.diagnostics);
		this._register(addDisposableListener(this.list, 'change', () => this.select()));
		this._register(addDisposableListener(this.list, 'focus', () => {
			if (this.configuration.getValue<boolean>('accessibility.verbosity.skills')) this.list.setAttribute('aria-description', localize('skills.hint', 'Skills. Use arrow keys to select a skill, Tab to navigate, and Alt+F1 for help.'));
			else this.list.removeAttribute('aria-description');
		}));
		this._register(marketplace.onDidChangeInstalled(() => { this.snapshot = undefined; if (this.visible && !this.working) { void this.run(() => this.load()); } }));
		this._register(skills.onDidChangeSkills(() => { this.snapshot = undefined; if (this.visible && !this.working) { void this.run(() => this.load()); } }));
		const scopedContext = this._register(contextKeys.createScoped(this.domNode));
		scopedContext.createKey('skillsSettingsFocused', true);
		this._register(AccessibleViewRegistry.register({
			type: AccessibleViewType.Help, priority: 100, name: `skills-help-${generateUuid()}`,
			when: ContextKeyExpr.has('skillsSettingsFocused'),
			getProvider: () => {
				const focused = this.domNode.ownerDocument.activeElement;
				if (!this.visible || !(focused instanceof HTMLElement) || !this.domNode.contains(focused)) { return undefined; }
				return new AccessibleContentProvider(AccessibleViewProviderId.Skills, { type: AccessibleViewType.Help },
					() => localize('skills.help', 'This view loads skill metadata and diagnostics. Select a skill by name and source to enable or disable it. Use $name in chat to invoke an enabled skill. Get skills opens Marketplace, including skills bundled in Plugins. Package installation and removal are managed there. If configuration changes elsewhere, refresh before changing enablement again. Use Tab and Shift+Tab to navigate, arrow keys to select a skill, and Escape to close help.'), () => focused.focus(), AccessibilityVerbositySettingId.Skills);
			},
		}));
		this.applyEnabled();
	}
	public setVisible(visible: boolean): void { this.visible = visible; if (visible && (!this.snapshot || this.snapshotSessionId !== this.sessions.getActiveConversation()?.sessionId)) { void this.run(() => this.load()); } }
	public getNodes(): readonly SettingsTreeNode<SettingsContentItem>[] {
		return [{ element: { kind: 'item', id: 'skills.catalog', title: localize('skills.title', 'Skills'), description: '', keywords: ['skills', 'capabilities', ...this.snapshot?.catalog.skills.flatMap(skill => [skill.id.name, skill.id.source, skill.description]) ?? []], value: { domNode: this.domNode } } }];
	}

	private async load(): Promise<void> {
		const generation = ++this.generation;
		const sessionId = this.sessions.getActiveConversation()?.sessionId;
		const snapshot = await this.skills.readSkillManagement(sessionId);
		if (this.isDisposed || generation !== this.generation || sessionId !== this.sessions.getActiveConversation()?.sessionId) { return; }
		const current = this.list.value;
		this.snapshot = snapshot;
		this.snapshotSessionId = sessionId;
		this.list.replaceChildren(...snapshot.catalog.skills.map(skill => {
			const option = h(this.domNode.ownerDocument, 'option'); option.value = JSON.stringify(skill.id); option.textContent = `${skill.id.name} · ${skill.id.source} · ${skill.enabled ? localize('skills.enabled', 'Enabled') : localize('skills.disabled', 'Disabled')}`; return option;
		}));
		this.list.value = snapshot.catalog.skills.some(skill => JSON.stringify(skill.id) === current) ? current : this.list.options[0]?.value ?? '';
		this.diagnostics.textContent = snapshot.diagnostics.length ? snapshot.diagnostics.map(entry => `${entry.source}${entry.subject ? ` / ${entry.subject}` : ''}: ${entry.message}`).join('\n') : localize('skills.noDiagnostics', 'No skill diagnostics.');
		this.status.textContent = localize('skills.count', '{0} skills. Invoke enabled skills with $name in chat.', snapshot.catalog.skills.length);
		this.select();
		this.changed.fire();
	}
	private select(): void {
		const skill = this.snapshot?.catalog.skills.find(skill => JSON.stringify(skill.id) === this.list.value);
		this.detail.textContent = skill ? `${skill.id.name}\n${localize('skills.source', 'Source: {0}', skill.id.source)}\n${skill.description}\n${skill.compatible ? localize('skills.compatible', 'Compatible') : localize('skills.unknownCompatibility', 'Compatibility unknown')}` : '';
		this.toggle.textContent = skill?.enabled ? localize('skills.disable', 'Disable skill') : localize('skills.enable', 'Enable skill');
		this.applyEnabled();
	}
	private async setEnabled(): Promise<void> {
		const snapshot = this.snapshot;
		const skill = snapshot?.catalog.skills.find(skill => JSON.stringify(skill.id) === this.list.value);
		if (!snapshot || !skill || this.working) { return; }
		this.working = true; this.applyEnabled();
		try { await this.skills.setSkillEnablement(skill.id, !skill.enabled, snapshot.revision, this.snapshotSessionId); if (!this.isDisposed) { await this.load(); } }
		finally { this.working = false; if (!this.isDisposed) { this.applyEnabled(); this.toggle.focus(); } }
	}
	private applyEnabled(): void {
		for (const control of this.domNode.querySelectorAll<HTMLButtonElement | HTMLSelectElement>('button, select')) { control.disabled = this.working; }
		this.toggle.disabled = this.working || !this.snapshot || !this.list.value;
		this.domNode.setAttribute('aria-busy', String(this.working));
	}
	private async run(action: () => Promise<void>): Promise<void> { try { await action(); } catch (error) { if (!this.isDisposed) { this.status.textContent = error instanceof Error ? error.message : String(error); } } }
	private async showHelp(): Promise<void> {
		const focus = this.domNode.ownerDocument.activeElement;
		await this.dialogs.showMessage({ title: localize('skills.helpTitle', 'Skills help'), severity: DialogSeverity.Info, message: localize('skills.help', 'This view loads skill metadata and diagnostics. Select a skill by name and source to enable or disable it. Use $name in chat to invoke an enabled skill. Get skills opens Marketplace, including skills bundled in Plugins. Package installation and removal are managed there. If configuration changes elsewhere, refresh before changing enablement again. Use Tab and Shift+Tab to navigate, arrow keys to select a skill, and Escape to close help.') });
		if (focus instanceof HTMLElement && focus.isConnected) { focus.focus(); }
	}
	private button(label: string, action: () => Promise<void>): HTMLButtonElement {
		const button = h(this.domNode.ownerDocument, 'button'); button.type = 'button'; button.textContent = label;
		this._register(addDisposableListener(button, 'click', () => { void this.run(action); })); return button;
	}
}
