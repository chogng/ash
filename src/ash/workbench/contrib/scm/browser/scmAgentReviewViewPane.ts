import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { ButtonWithDropdown } from '../../../../base/browser/ui/button/button.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import type { IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { ViewPane } from '../../../browser/parts/views/viewPane.js';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { Separator, type IAction } from '../../../../base/common/actions.js';
import { cancelOnDispose } from '../../../../base/common/cancellation.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { createUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import type { AgentReviewTarget } from '../../../../platform/agentHost/common/agent.js';
import { IAgentSessionService } from '../../../../platform/agentHost/common/agentService.js';
import { ChatAIDisabledSettingId } from '../../../../platform/chat/common/chatSettings.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { IChatService } from '../../../services/chat/common/chatService.js';
import { IChatSessionNavigationService } from '../../../services/chat/common/chatSessionNavigationService.js';
import { ISCMViewService, type ISCMProvider } from '../common/scm.js';

type ReviewScope = 'current' | 'staged' | 'branch' | 'custom';

/** Starts repository reviews in Chat while keeping the primary action's scope fixed. */
export class ScmAgentReviewViewPane extends ViewPane {
	private readonly findIssues: ButtonWithDropdown;
	private readonly message: HTMLParagraphElement;
	private readonly cancellation = cancelOnDispose(this._store);
	private pending = false;

	constructor(
		container: HTMLElement, options: IViewPaneOptions,
		@ISCMViewService private readonly scmViewService: ISCMViewService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IAgentSessionService private readonly sessionService: IAgentSessionService,
		@IChatService private readonly chatService: IChatService,
		@IChatSessionNavigationService private readonly navigation: IChatSessionNavigationService,
		@INotificationService private readonly notifications: INotificationService,
		@IConfigurationService private readonly configuration: IConfigurationService,
	) {
		super(container, options);
		this.contentElement.classList.add('ash-scm-secondary-pane');
		this.message = h(container.ownerDocument, 'p');
		this.message.className = 'ash-scm-empty';
		this.message.setAttribute('role', 'status');
		this.message.hidden = true;
		this.contentElement.append(this.message);
		this.findIssues = this._register(new ButtonWithDropdown(this.contentElement, {
			...defaultButtonStyles,
			label: localize('scm.review.findIssues', 'Find Issues'),
			icon: Lxicon.codeReview,
			presentation: 'primary',
			contentAlignment: 'groupCentered',
			title: localize('scm.review.currentHint', 'Review staged, unstaged and untracked changes in the selected repository'),
			contextMenuProvider: contextMenuService,
			addPrimaryActionToDropdown: false,
			actions: { getActions: () => this.reviewActions() },
			onClick: () => { void this.startReview('current'); },
		}));
		this.findIssues.element.classList.add('ash-scm-find-issues');
		const more = localize('scm.review.moreActions', 'Choose Review Scope');
		this.findIssues.dropdownButton.domNode.setAttribute('aria-label', more);
		this.findIssues.dropdownButton.setTitle(more);
		this._register(addDisposableListener(this.findIssues.element, 'focusin', () => {
			const hint = this.configuration.getValue<boolean>(AccessibilityVerbositySettingId.Scm) === false
				? '' : localize('scm.review.helpHint', 'Press Alt+F1 for Agent Review accessibility help.');
			this.findIssues.primaryButton.domNode.setAttribute('aria-description', hint);
			this.findIssues.dropdownButton.domNode.setAttribute('aria-description', hint);
		}));
		this._register(this.scmViewService.onDidChangeActiveRepository(() => this.updateEnabled()));
		this._register(this.configuration.onDidChangeConfiguration(() => this.updateEnabled()));
		this.updateEnabled();
	}

	private updateEnabled(): void {
		this.findIssues.enabled = !this.pending && !!this.scmViewService.activeRepository
			&& !this.configuration.getValue<boolean>(ChatAIDisabledSettingId);
	}

	private reviewActions(): IAction[] {
		const action = (scope: ReviewScope, label: string): IAction => ({
			id: `scm.review.${scope}`, label, tooltip: label, enabled: this.findIssues.enabled,
			run: () => this.startReview(scope),
		});
		return [
			action('current', localize('scm.review.current', 'Review Current Changes')),
			action('staged', localize('scm.review.staged', 'Review Staged Changes Only')),
			action('branch', localize('scm.review.branch', 'Review Branch Changes...')),
			new Separator(),
			action('custom', localize('scm.review.custom', 'Custom Review...')),
		];
	}

	private async startReview(scope: ReviewScope): Promise<void> {
		const provider = this.scmViewService.activeRepository?.provider;
		if (!provider || !this.findIssues.enabled || this.isDisposed) {
			return;
		}
		this.pending = true;
		this.updateEnabled();
		try {
			const root = provider.rootUri;
			if (!root || root.scheme !== Schemas.file) {
				throw new Error(localize('scm.review.localRepository', 'Select a local Git repository to start a review.'));
			}
			let target: AgentReviewTarget = { type: 'uncommittedChanges' };
			if (scope === 'staged') {
				target = { type: 'stagedChanges' };
			}
			if (scope === 'branch') {
				const branch = await this.selectBranch(provider);
				if (!branch) {
					return;
				}
				target = { type: 'baseBranch', branch };
			}
			if (scope === 'custom') {
				const instructions = await this.quickInputService.input({
					title: localize('scm.review.custom', 'Custom Review...'),
					placeHolder: localize('scm.review.focusPlaceholder', 'Review current changes, focusing on concurrency, security, tests...'),
					validateInput: async value => value.trim() ? undefined : localize('scm.review.focusRequired', 'Enter a review focus.'),
				}, this.cancellation);
				if (!instructions?.trim()) {
					return;
				}
				target = { type: 'custom', instructions: localize('scm.review.customInstructions', 'Review all staged, unstaged and untracked changes in the current repository. Do not modify files or the index. Additional review focus: {0}', instructions.trim()) };
			}
			// A picker captures its repository; switching repositories must never retarget it.
			if (this.isDisposed || this.scmViewService.activeRepository?.provider !== provider
				|| this.configuration.getValue<boolean>(ChatAIDisabledSettingId)) {
				return;
			}
			this.message.hidden = false;
			this.message.textContent = localize('scm.review.starting', 'Starting review...');
			const created = await this.sessionService.create({
				commandId: createUuid(), title: localize('scm.review.sessionTitle', 'Code Review: {0}', provider.activeRepositoryName ?? provider.label),
				executionTarget: { type: 'local', root: root.fsPath }, agent: { type: 'default' },
			});
			if (this.isDisposed) {
				await this.sessionService.unsubscribe({ sessionId: created.session.sessionId });
				return;
			}
			const thread = created.session.threads.find(item => item.status === 'active' && !item.parentThreadId && !item.forkedFromId);
			if (!thread) {
				throw new Error(localize('scm.review.noThread', 'The review conversation could not be created.'));
			}
			const sessionId = created.session.sessionId;
			// Open first so Chat owns the live subscription and any reviewer interactions.
			await this.navigation.openConversation(sessionId, thread.threadId);
			const snapshot = await this.chatService.readThread(sessionId, thread.threadId);
			if (this.isDisposed) {
				return;
			}
			await this.chatService.startReview({ sessionId, threadId: thread.threadId, expectedSequence: snapshot.thread.sequence, target });
			if (!this.isDisposed) {
				this.message.textContent = localize('scm.review.started', 'Review started in Chat.');
			}
		} catch (error) {
			if (!this.isDisposed && !isCancellationError(error)) {
				this.message.hidden = false;
				this.message.textContent = localize('scm.review.failed', 'Could not start review. Try again.');
				this.notifications.error(error instanceof Error ? error : String(error));
			}
		} finally {
			this.pending = false;
			if (!this.isDisposed) {
				this.updateEnabled();
			}
		}
	}

	private async selectBranch(provider: ISCMProvider): Promise<string | undefined> {
		using resources = new DisposableStore();
		type BranchPick = IQuickPickItem & { readonly branch: string; };
		const picker = resources.add(this.quickInputService.createQuickPick<BranchPick>());
		picker.placeholder = picker.ariaLabel = localize('scm.review.selectBranch', 'Select a base branch to review against');
		picker.busy = true;
		let dismissed = false;
		const selected = new Promise<string | undefined>(resolve => {
			resources.add(picker.onDidAccept(() => {
				const item = picker.selectedItems[0];
				if (item) {
					resolve(item.branch);
					picker.hide();
				}
			}));
			resources.add(picker.onDidHide(() => { dismissed = true; resolve(undefined); }));
			resources.add(this.cancellation.onCancellationRequested(() => { resolve(undefined); picker.hide(); }));
		});
		picker.show();
		const refs = await Promise.race([
			provider.historyProvider?.provideHistoryItemRefs?.() ?? Promise.resolve([]),
			selected.then(() => undefined),
		]);
		if (this.isDisposed || dismissed || !refs) {
			return undefined;
		}
		picker.items = refs.filter(ref => ref.category === 'localBranch' || ref.category === 'remoteBranch').map(ref => ({ label: ref.name, description: ref.description, branch: ref.id }));
		picker.busy = false;
		if (picker.items.length === 0) {
			picker.hide();
			const branch = await this.quickInputService.input({
				placeHolder: localize('scm.review.enterBranch', 'Enter a base branch, for example main or origin/main'),
				validateInput: async value => value.trim() ? undefined : localize('scm.review.branchRequired', 'Enter a base branch.'),
			}, this.cancellation);
			return branch?.trim();
		}
		// Await inside the using scope so the picker survives until the user decides.
		return await selected;
	}
}
