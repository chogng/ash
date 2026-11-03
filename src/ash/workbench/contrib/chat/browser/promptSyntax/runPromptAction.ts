import { Lxicon } from '../../../../../base/common/lxicons.js';
import { ResourceContext } from '../../../../common/contextkeys.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../../base/common/errors.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import type { SkillReference } from '../../../../../platform/agentHost/common/appServerApi.js';
import { ChatAIDisabledSettingId } from '../../../../../platform/chat/common/chatSettings.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { filterQuickPickItems } from '../../../../../platform/quickinput/browser/quickInputList.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { IChatSessionNavigationService } from '../../../../services/chat/common/chatSessionNavigationService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import type { SkillSelectorDefinition } from '../../../../services/chat/common/chatService.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { IPromptsService } from '../../common/promptSyntax/service/promptsService.js';
import { IChatWidgetService } from '../chat.js';

interface SkillPick extends IQuickPickItem { readonly definition: SkillSelectorDefinition; }

function sameSkill(a: SkillReference, b: SkillReference): boolean {
	return a.id.source === b.id.source && a.id.name === b.id.name && a.version.digest === b.version.digest;
}

async function runSkill(accessor: ServicesAccessor, current: boolean): Promise<void> {
	const configuration = accessor.get(IConfigurationService);
	if (configuration.getValue<boolean>(ChatAIDisabledSettingId)) return;
	const navigation = accessor.get(IChatSessionNavigationService);
	const widgets = accessor.get(IChatWidgetService);
	const quickInput = accessor.get(IQuickInputService);
	const notifications = accessor.get(INotificationService);
	const prompts = accessor.get(IPromptsService);
	const resource = accessor.get(IEditorService).activeEditor?.resource;
	using lifetime = new DisposableStore();
	const cancellation = lifetime.add(new CancellationTokenSource());
	lifetime.add(configuration.onDidChangeConfiguration(() => {
		if (configuration.getValue<boolean>(ChatAIDisabledSettingId)) cancellation.cancel();
	}));
	const assertCurrent = (): void => { if (cancellation.token.isCancellationRequested) throw new CancellationError(); };
	let required: SkillReference | undefined;
	let providerId: string | undefined;
	if (current) {
		const skill = resource && await prompts.resolveSkill(resource, cancellation.token);
		assertCurrent();
		if (!skill) {
			notifications.info(localize('prompt.run.openSkill', 'Open the Skill from Skills before running it.'));
			return;
		}
		required = { id: skill.id, version: { type: 'pinnedDigest', digest: skill.contentDigest } };
		providerId = skill.providerId;
	}
	const created = await navigation.createNewConversation({ focus: true, ...(providerId ? { providerId } : {}) });
	assertCurrent();
	if (created === false) return;
	const widget = widgets.lastFocusedWidget;
	const model = widget?.model;
	if (!widget?.visible || !model || !widgets.getAllWidgets().includes(widget)) return;
	const generation = model.composerGeneration;
	const validTarget = (): boolean => widget.visible && widgets.lastFocusedWidget === widget
		&& widgets.getAllWidgets().includes(widget) && widget.model === model && model.composerGeneration === generation;
	lifetime.add(widget.onDidHide(() => cancellation.cancel()));
	lifetime.add(widget.onDidChangeViewModel(() => cancellation.cancel()));
	lifetime.add(widgets.onDidChangeWidgets(() => { if (!validTarget()) cancellation.cancel(); }));
	lifetime.add(model.onDidChange(() => { if (!validTarget()) cancellation.cancel(); }));
	const ready = (): boolean => model.inputState.phase !== 'loading' && !model.inputState.skillSelectorsLoading;
	if (!ready()) {
		using readiness = new DisposableStore();
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(localize('prompt.run.notReady', 'The new chat’s Skill list is not ready. Try again when the chat finishes loading.'))), 15_000);
			readiness.add(toDisposable(() => clearTimeout(timer)));
			readiness.add(cancellation.token.onCancellationRequested(() => reject(new CancellationError())));
			readiness.add(model.onDidChange(() => { if (ready()) resolve(); }));
			if (ready()) resolve();
		});
	}
	assertCurrent();
	if (!validTarget() || !model.inputState.canSelectAgent) throw new CancellationError();
	const available = model.inputState.skillSelectors;
	let selected = required ? available.find(skill => sameSkill(skill.skill, required)) : undefined;
	if (!required && available.length) {
		const picker = lifetime.add(quickInput.createQuickPick<SkillPick>());
		const items = available.map(definition => ({ label: `$${definition.name}`, description: definition.source, detail: definition.description, definition }));
		picker.items = items;
		picker.placeholder = picker.ariaLabel = localize('prompt.run.chooseSkill', 'Choose a Skill to run in this new chat');
		lifetime.add(picker.onDidChangeValue(value => { picker.items = filterQuickPickItems(items, value); }));
		selected = await new Promise<SkillSelectorDefinition | undefined>(resolve => {
			lifetime.add(picker.onDidAccept(() => { const item = picker.selectedItems[0]; if (item) { resolve(item.definition); picker.hide(); } }));
			lifetime.add(picker.onDidHide(() => resolve(undefined)));
			lifetime.add(cancellation.token.onCancellationRequested(() => { resolve(undefined); picker.hide(); }));
			picker.show();
		});
	}
	assertCurrent();
	if (!selected) {
		if (required || !available.length) notifications.info(localize('prompt.run.unavailable', 'This chat has no matching enabled Skill. Check its host and Skill settings.'));
		return;
	}
	// The new conversation's own catalog, rather than an ambient window catalog,
	// decides whether a reference belongs to its backend and is still available.
	if (!validTarget() || !model.inputState.skillSelectors.some(skill => sameSkill(skill.skill, selected.skill))) throw new CancellationError();
	const draft = await widget.input.captureDraft();
	assertCurrent();
	if (!validTarget() || !model.inputState.skillSelectors.some(skill => sameSkill(skill.skill, selected.skill))) throw new CancellationError();
	if (draft) throw new Error(localize('prompt.run.draftConflict', 'The new chat already has an unsent draft. Keep it or send it before running a Skill.'));
	widget.input.attachSkill(selected.skill);
	widget.focusInput();
	await widget.acceptInput();
}

/** Reusable work runs through native Skills and the existing Chat submission owner. */
export function registerRunPromptActions(): DisposableStore {
	const registrations = new DisposableStore();
	for (const definition of [
		{ id: 'workbench.action.chat.run.prompt', current: false, title: localize2('prompt.run.choose', 'Chat: Run Skill in New Chat…') },
		{ id: 'workbench.action.chat.run.prompt.current', current: true, title: localize2('prompt.run.current', 'Chat: Run Current Skill in New Chat') },
	]) {
		registrations.add(registerAction2(class extends Action2 {
			constructor() {
				super({
					id: definition.id, title: definition.title, f1: true, precondition: ChatContextKeys.enabled.isEqualTo(true),
					...(definition.current ? { icon: Lxicon.play, menu: { id: MenuId.EditorTitle, group: 'navigation', order: 5, when: ContextKeyExpr.regex(ResourceContext.key, /^private:\/\/skill\/.*\/SKILL\.md(?:\?|$)/u) } } : {}),
				});
			}
			public override run(accessor: ServicesAccessor): Promise<void> { return runSkill(accessor, definition.current); }
		}));
	}
	return registrations;
}
