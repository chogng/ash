import { localize } from '../../../../nls.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IAutomationService } from '../../../../workbench/contrib/chat/common/automations/automationService.js';
import type { IAutomationDialogService, IShowAutomationDialogOptions, IAutomationDialogResult } from '../../../../workbench/contrib/chat/common/automations/automationDialogService.js';
import { IChatSessionNavigationService } from '../../../../workbench/services/chat/common/chatSessionNavigationService.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { AutomationDialog } from './automationDialog.js';
import { LOCAL_AGENT_HOST_PROVIDER_ID } from '../../../common/agentHostSessionsProvider.js';

export class AutomationDialogService extends Disposable implements IAutomationDialogService {
	private readonly active = this._register(new MutableDisposable<AutomationDialog>());
	private queue: Promise<unknown> = Promise.resolve();

	constructor(
		@IAutomationService private readonly automations: IAutomationService,
		@ISessionsService private readonly sessions: ISessionsService,
		@IChatSessionNavigationService private readonly navigation: IChatSessionNavigationService,
		@ILayoutService private readonly layout: ILayoutService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
	) { super(); }

	showAutomationDialog(options: IShowAutomationDialogOptions): Promise<IAutomationDialogResult | undefined> {
		const pending = this.queue.then(() => this.isDisposed ? undefined : this.open(options));
		this.queue = pending.catch(() => undefined);
		return pending;
	}

	private async open(options: IShowAutomationDialogOptions): Promise<IAutomationDialogResult | undefined> {
		const chat = (options.existing?.target ?? options.initialValues?.target)?.session.type === 'newChat' || options.sessionKind === 'chat';
		const available = this.automations.availableProviders.get();
		const providers = chat ? available.filter(provider => provider.id === LOCAL_AGENT_HOST_PROVIDER_ID && provider.supportsChatSchedules) : available;
		const requested = options.existing?.target.providerId ?? options.initialValues?.target?.providerId;
		if (!providers.length || requested && !providers.some(provider => provider.id === requested)) throw new Error(localize('automations.hostUnavailable', 'Connect to the owning execution host and try again.'));
		const selection = this.sessions.activeSelection;
		const workspace = selection?.kind === 'session' ? selection.active.session.chats.find(chat => chat.threadId === selection.active.threadId)?.workspace : undefined;
		const directory = selection?.kind === 'untitled' && selection.session.workspace.type === 'local' ? selection.session.workspace.root : workspace?.authorityId === 'local' ? workspace.root : '';
		const commit = options.commit ?? (async (result: IAutomationDialogResult): Promise<void> => {
			if (result.kind === 'create') await this.automations.createAutomation(result.value);
			else {
				const updated = await this.automations.updateAutomationIfUnchanged(result.id, result.value, options.existing!);
				if (updated.kind === 'conflict') throw new Error(localize('automations.editConflict', 'This task changed. Refresh it before saving.'));
			}
		});
		const captured: IShowAutomationDialogOptions = options.existing ? { existing: options.existing, commit } : {
			initialValues: {
				...options.initialValues,
				target: chat
					? { providerId: providers[0]!.id, directory: '', session: { type: 'newChat' } }
					: options.initialValues?.target ?? { providerId: requested ?? providers[0]!.id, directory, session: { type: 'new' } },
			},
			commit,
		};
		const conversations = chat ? [] : this.navigation.getConversations().filter(conversation => conversation.kind !== 'chat');
		const dialog = this.instantiation.createInstance(AutomationDialog, this.layout.activeContainer, captured, providers, conversations);
		this.active.value = dialog;
		try { return await dialog.show(); }
		finally { this.active.clear(); }
	}
}
