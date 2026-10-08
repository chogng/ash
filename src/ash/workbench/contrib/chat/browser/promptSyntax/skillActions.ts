import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IPreferencesService } from '../../../../services/preferences/common/preferences.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IChatSessionNavigationService } from '../../../../services/chat/common/chatSessionNavigationService.js';
import { IPromptsService, type IAgentSkill } from '../../common/promptSyntax/service/promptsService.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { filterQuickPickItems } from '../../../../../platform/quickinput/browser/quickInputList.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { isCancellationError } from '../../../../../base/common/errors.js';

export const CONFIGURE_SKILLS_ACTION_ID = 'workbench.action.chat.configure.skills';

interface SkillPick extends IQuickPickItem {
	readonly skill?: IAgentSkill;
	readonly manage?: true;
}

export function registerSkillActions(): void {
	registerAction2(class extends Action2 {
		constructor() {
			super({ id: CONFIGURE_SKILLS_ACTION_ID, title: localize2({ bundle: 'ash', key: 'skills.open' }, 'Open skills'), f1: true });
		}

		public override async run(accessor: ServicesAccessor): Promise<void> {
			const prompts = accessor.get(IPromptsService);
			const sessions = accessor.get(IChatSessionNavigationService);
			const editors = accessor.get(IEditorService);
			const preferences = accessor.get(IPreferencesService);
			const notifications = accessor.get(INotificationService);
			const sessionId = sessions.getActiveConversation()?.sessionId;
			using lifetime = new DisposableStore();
			const picker = lifetime.add(accessor.get(IQuickInputService).createQuickPick<SkillPick>());
			const cancellation = lifetime.add(new CancellationTokenSource());
			picker.ariaLabel = localize('skills.selectFile', 'Select a skill file to open');
			picker.placeholder = localize('skills.selectFile', 'Select a skill file to open');
			picker.busy = true;
			const manage: SkillPick = { label: localize('skills.manageEnablement', 'Manage skill enablement…'), manage: true, alwaysShow: true };
			let items: readonly SkillPick[] = [manage];
			picker.items = items;
			const selected = new Promise<SkillPick | undefined>(resolve => {
				lifetime.add(picker.onDidAccept(item => resolve(item)));
				lifetime.add(picker.onDidHide(() => { cancellation.cancel(); resolve(undefined); }));
				lifetime.add(picker.onDidChangeValue(value => { picker.items = filterQuickPickItems(items, value); }));
			});
			picker.show();
			void prompts.findAgentSkills(cancellation.token, sessionId).then(skills => {
				if (cancellation.token.isCancellationRequested) return;
				items = [...skills.map(skill => ({ label: skill.name, description: skill.id.source, detail: skill.description, skill })), manage];
				picker.items = filterQuickPickItems(items, picker.value);
				picker.busy = false;
			}, error => {
				if (cancellation.token.isCancellationRequested) return;
				if (!isCancellationError(error)) notifications.error(localize('skills.discoveryFailed', 'Unable to load skill files. Try refreshing the catalog.'));
				picker.hide();
			});
			const choice = await selected;
			if (!choice) return;
			if (choice.manage) {
				picker.hide();
				await preferences.openSettings({ section: 'skills' });
				return;
			}
			const skill = choice.skill;
			if (!skill) return;
			picker.busy = true;
			try {
				const parsed = await prompts.parseNew(skill.uri, cancellation.token);
				if (cancellation.token.isCancellationRequested || sessionId !== sessions.getActiveConversation()?.sessionId) return;
				picker.hide();
				await editors.openEditor({ resource: skill.uri, initialText: parsed.content, languageId: 'markdown', label: `${skill.name}/SKILL.md`, readOnly: true, showBreadcrumbs: false }, { pinned: true });
			} catch (error) {
				if (!isCancellationError(error) && !cancellation.token.isCancellationRequested) notifications.error(localize('skills.openFailed', 'Unable to open skill {0}. Refresh the catalog and try again.', skill.name));
			} finally { picker.hide(); }
		}
	});
}
