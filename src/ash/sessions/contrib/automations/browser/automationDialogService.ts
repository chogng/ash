import { localize } from '../../../../nls.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IAutomationService } from '../../../../workbench/contrib/chat/common/automations/automationService.js';
import type { IAutomationDialogService, IShowAutomationDialogOptions, IAutomationDialogResult } from '../../../../workbench/contrib/chat/common/automations/automationDialogService.js';
import { IChatSessionNavigationService } from '../../../../workbench/services/chat/common/chatSessionNavigationService.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { AutomationDialog } from './automationDialog.js';

export class AutomationDialogService extends Disposable implements IAutomationDialogService {
	private readonly active = this._register(new MutableDisposable<AutomationDialog>());
	private queue: Promise<unknown> = Promise.resolve();

	constructor(
		@IAutomationService private readonly automations: IAutomationService,
		@ISessionsService private readonly sessions: ISessionsService,
		@IChatSessionNavigationService private readonly navigation: IChatSessionNavigationService,
		@ILayoutService private readonly layout: ILayoutService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
	) {
		super();
	}

	showAutomationDialog(options: IShowAutomationDialogOptions): Promise<IAutomationDialogResult | undefined> {
		const pending = this.queue.then(() => (this.isDisposed ? undefined : this.open(options)));
		this.queue = pending.catch(() => undefined);
		return pending;
	}

	private async open(options: IShowAutomationDialogOptions): Promise<IAutomationDialogResult | undefined> {
		const providers = this.automations.availableProviders.get();
		const requested = options.existing?.target.providerId ?? options.initialValues?.target?.providerId;
		if (!providers.length || (requested && !this.automations.canCreateAutomation(requested)))
			throw new Error(localize('automations.hostUnavailable', 'Connect to the owning automation host and try again.'));
		const selection = this.sessions.activeSelection;
		const workspace = selection?.kind === 'session' ? selection.active.session.chats.find(chat => chat.threadId === selection.active.threadId)?.workspace : undefined;
		const directory = selection?.kind === 'untitled' && selection.session.workspace.type === 'local' ? selection.session.workspace.root : workspace?.authorityId === 'local' ? workspace.root : '';
		const commit =
			options.commit ??
			(async (result: IAutomationDialogResult): Promise<void> => {
				if (result.kind === 'create') await this.automations.createAutomation(result.value);
				else {
					const updated = await this.automations.updateAutomationIfUnchanged(result.id, result.value, options.existing!);
					if (updated.kind === 'conflict') throw new Error(localize('automations.editConflict', 'This automation changed. Refresh it before saving.'));
				}
			});
		const captured: IShowAutomationDialogOptions = options.existing
			? { existing: options.existing, commit }
			: {
					initialValues: {
						target: { providerId: requested ?? providers[0]!.id, directory, session: { type: 'new' } },
						...options.initialValues,
					},
					commit,
				};
		const dialog = this.instantiation.createInstance(AutomationDialog, this.layout.activeContainer, captured, providers, this.navigation.getConversations());
		this.active.value = dialog;
		try {
			return await dialog.show();
		} finally {
			this.active.clear();
		}
	}
}
