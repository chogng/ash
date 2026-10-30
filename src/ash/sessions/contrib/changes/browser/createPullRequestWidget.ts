import { defaultButtonStyles, defaultInputBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import './media/createPullRequest.css';
import { h, addDisposableListener } from '../../../../base/browser/dom.js';
import { Button, ButtonWithDropdown } from '../../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputbox.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { getErrorMessage, isCancellationError } from '../../../../base/common/errors.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IAccessibleViewService, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { GitHubError, GitHubErrorCode } from '../../../../platform/github/common/githubService.js';
import type { ISessionPullRequestCreation, ISessionPullRequestDetails, ISessionPullRequestOptions, SessionPullRequestMergeMethod } from '../common/pullRequestCreation.js';
import { CreatePullRequestFocusedContext } from '../common/changes.js';
import { CreatePullRequestPreferences } from '../common/createPullRequestPreferences.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { CreatePullRequestChatRequest } from './createPullRequestChatRequest.js';

export interface ICreatePullRequestWidgetOptions {
	readonly creation: ISessionPullRequestCreation;
	readonly onCancel: () => void;
	readonly onCreated: (options: ISessionPullRequestOptions, message: string) => void;
	readonly onDetachedError: (error: Error) => void;
	readonly onSendToChat?: (options: ISessionPullRequestOptions) => Promise<void>;
}

/** An editable form whose preparation and submission have separate lifetimes. */
export class CreatePullRequestWidget extends Disposable {
	public readonly domNode: HTMLElement;
	public readonly ready: Promise<void>;
	private readonly titleInput: InputBox;
	private readonly descriptionInput: InputBox<true>;
	private readonly baseInput: InputBox;
	private readonly draft: HTMLInputElement;
	private readonly merge: HTMLSelectElement;
	private primaryAction: 'create' | 'sendToChat';
	private readonly preferences: CreatePullRequestPreferences;
	private readonly submit: Button | ButtonWithDropdown;
	private readonly cancel: Button;
	private readonly message: HTMLElement;
	private readonly generation = this._register(new CancellationTokenSource());
	private details: ISessionPullRequestDetails | undefined;
	private titleEdited = false;
	private descriptionEdited = false;
	private baseEdited = false;
	private submitting = false;

	constructor(
		private readonly options: ICreatePullRequestWidgetOptions,
		ownerDocument: Document,
		@IContextKeyService contextKeys: IContextKeyService,
		@IAccessibleViewService accessibleViews: IAccessibleViewService,
		@IConfigurationService configuration: IConfigurationService,
		@IInstantiationService instantiation: IInstantiationService,
		@IContextMenuService contextMenus: IContextMenuService,
	) {
		super();
		this.preferences = instantiation.createInstance(CreatePullRequestPreferences);
		const preferences = this.preferences.read();
		this._register(toDisposable(() => this.generation.cancel()));
		this.domNode = h(ownerDocument, 'form', { className: 'ash-sessions-create-pr' });
		this._register(toDisposable(() => this.domNode.remove()));
		this.domNode.setAttribute('role', 'dialog');
		this.domNode.setAttribute('aria-label', localize('sessions.changes.createPR', 'Create pull request'));
		const context = this._register(contextKeys.createScoped(this.domNode));
		CreatePullRequestFocusedContext.bindTo(context).set(true);
		const updateHint = (): void => {
			const hint = accessibleViews.getOpenAriaHint(AccessibilityVerbositySettingId.SessionsChanges);
			if (hint) { this.domNode.setAttribute('aria-description', hint); }
			else { this.domNode.removeAttribute('aria-description'); }
		};
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(AccessibilityVerbositySettingId.SessionsChanges)) { updateHint(); }
		}));
		updateHint();
		const heading = h(ownerDocument, 'h3');
		heading.textContent = localize('sessions.changes.createPR', 'Create pull request');
		this.domNode.append(heading);
		const title = localize('sessions.changes.prTitle', 'Title');
		this.titleInput = this._register(new InputBox(this.domNode, {
			inputBoxStyles: defaultInputBoxStyles,
			ariaLabel: title,
			placeholder: title,
			presentation: 'field',
		}));
		this._register(this.titleInput.onDidChange(() => { this.titleEdited = true; }));
		const base = localize('sessions.changes.prBase', 'Target branch');
		this.baseInput = this._register(new InputBox(this.domNode, {
			inputBoxStyles: defaultInputBoxStyles,
			ariaLabel: base,
			placeholder: base,
			presentation: 'field',
		}));
		this._register(this.baseInput.onDidChange(() => { this.baseEdited = true; }));
		const description = localize('sessions.changes.prDescription', 'Description');
		this.descriptionInput = this._register(new InputBox(this.domNode, {
			inputBoxStyles: defaultInputBoxStyles,
			ariaLabel: description,
			placeholder: description,
			presentation: 'field',
			flexibleHeight: true,
		}));
		this._register(this.descriptionInput.onDidChange(() => { this.descriptionEdited = true; }));
		const draftLabel = h(ownerDocument, 'label');
		this.draft = h(ownerDocument, 'input');
		this.draft.type = 'checkbox';
		this.draft.checked = preferences.draft ?? false;
		this.draft.setAttribute('aria-label', localize('sessions.changes.prDraft', 'Create as draft'));
		draftLabel.append(this.draft, ownerDocument.createTextNode(localize('sessions.changes.prDraft', 'Create as draft')));
		this.domNode.append(draftLabel);
		this.merge = h(ownerDocument, 'select');
		this.merge.setAttribute('aria-label', localize('sessions.changes.prMerge', 'Merge mode'));
		this.merge.hidden = true;
		this._register(addDisposableListener(this.draft, 'change', () => {
			this.merge.disabled = this.draft.checked;
			if (this.draft.checked) {
				this.merge.value = '';
			}
		}));
		this.domNode.append(this.merge);
		this.primaryAction = options.onSendToChat && preferences.primaryAction === 'sendToChat' ? 'sendToChat' : 'create';
		this.message = h(ownerDocument, 'p');
		this.message.setAttribute('role', 'status');
		this.message.textContent = localize('sessions.changes.prLoading', 'Preparing pull request…');
		this.domNode.append(this.message);
		const actions = h(ownerDocument, 'div', { className: 'ash-sessions-create-pr-actions' });
		this.domNode.append(actions);
		this.cancel = this._register(new Button(actions, {
			...defaultButtonStyles,
			label: localize('sessions.changes.prCancel', 'Cancel'),
			onClick: options.onCancel,
		}));
		const submitOptions = {
			...defaultButtonStyles,
			label: this.primaryAction === 'sendToChat' ? localize('sessions.changes.prSend', 'Send to agent') : localize('sessions.changes.createPR', 'Create pull request'),
			type: 'submit' as const,
			enabled: false,
			presentation: 'primary' as const,
		};
		if (options.onSendToChat) {
			this.submit = this._register(new ButtonWithDropdown(actions, {
				...submitOptions, contextMenuProvider: contextMenus, addPrimaryActionToDropdown: false,
				actions: {
					getActions: () => (['create', 'sendToChat'] as const).map(action => ({
						id: `sessions.createPullRequest.${action}`,
						label: action === 'create' ? localize('sessions.changes.prDirect', 'Create directly') : localize('sessions.changes.prAgent', 'Ask agent to create'),
						tooltip: '', checked: this.primaryAction === action, enabled: this.submit.enabled,
						run: () => {
							this.primaryAction = action;
							this.submit.label = action === 'sendToChat' ? localize('sessions.changes.prSend', 'Send to agent') : localize('sessions.changes.createPR', 'Create pull request');
							return this.create();
						},
					}))
				},
			}));
			this.submit.dropdownButton.domNode.setAttribute('aria-label', localize('sessions.changes.prAction', 'Pull request action'));
			this.submit.dropdownButton.setTitle(localize('sessions.changes.prAction', 'Pull request action'));
		} else {
			this.submit = this._register(new Button(actions, submitOptions));
		}
		this._register(addDisposableListener(this.domNode, 'submit', event => {
			event.preventDefault();
			void this.create();
		}));
		this._register(addDisposableListener(this.domNode, 'keydown', event => {
			if (event.key === 'Escape') {
				event.preventDefault();
				event.stopPropagation();
				options.onCancel();
			}
			if (event.key === 'Tab') {
				const targets = [...this.domNode.querySelectorAll<HTMLElement>('input:not(:disabled), textarea:not(:disabled), select:not(:disabled), button:not(:disabled)')].filter(element => !element.hidden);
				const first = targets[0];
				const last = targets.at(-1);
				if (event.shiftKey && ownerDocument.activeElement === first) {
					event.preventDefault();
					last?.focus();
				}
				if (!event.shiftKey && ownerDocument.activeElement === last) {
					event.preventDefault();
					first?.focus();
				}
			}
		}));
		this.ready = this.prepare();
	}

	public focus(): void { this.titleInput.focus(); }

	private async prepare(): Promise<void> {
		try {
			const details = await this.options.creation.prepare(this.generation.token);
			if (this.isDisposed) { return; }
			this.details = details;
			if (!this.titleEdited) { this.titleInput.value = details.title; }
			if (!this.baseEdited) { this.baseInput.value = details.baseBranchName; }
			if (!this.descriptionEdited) { this.descriptionInput.value = details.description; }
			this.message.textContent = localize('sessions.changes.prContext', '{0}: {1} → {2}', details.repository, details.branchName, details.baseBranchName);
			if (details.autoMergeAllowed && details.mergeMethods.length) {
				this.merge.hidden = false;
				const manual = h(this.domNode.ownerDocument, 'option');
				manual.value = '';
				manual.textContent = localize('sessions.changes.prManual', 'Merge manually');
				this.merge.append(manual);
				for (const method of details.mergeMethods) {
					const option = h(this.domNode.ownerDocument, 'option');
					option.value = method;
					option.textContent = method === 'MERGE'
						? localize('sessions.changes.prAutoMerge', 'Auto-merge with a merge commit')
						: method === 'SQUASH'
							? localize('sessions.changes.prAutoSquash', 'Auto-merge with squash')
							: localize('sessions.changes.prAutoRebase', 'Auto-merge with rebase');
					this.merge.append(option);
				}
				const preferences = this.preferences.read();
				if (preferences.mergeMode === 'auto' && preferences.mergeMethod && details.mergeMethods.includes(preferences.mergeMethod) && !this.draft.checked) { this.merge.value = preferences.mergeMethod; }
			}
			this.merge.disabled = this.draft.checked;
			this.submit.enabled = true;
		} catch (error) {
			if (!this.isDisposed && !isCancellationError(error)) { this.message.textContent = this.errorMessage(error); }
		}
	}

	private async create(): Promise<void> {
		if (!this.details || this.submitting || !this.submit.enabled) { return; }
		const title = this.titleInput.value.trim();
		const base = this.baseInput.value.trim();
		if (!title || !base || base === this.details.branchName) {
			this.message.textContent = localize('sessions.changes.prRequired', 'Enter a title and a target branch different from the source branch.');
			(!title ? this.titleInput : this.baseInput).focus();
			return;
		}
		const autoMergeMethod = this.merge.value as SessionPullRequestMergeMethod | '';
		const options: ISessionPullRequestOptions = {
			title,
			description: this.descriptionInput.value,
			draft: this.draft.checked,
			expectedContext: { ...this.details.context, baseBranchName: base },
			...(autoMergeMethod ? { autoMergeMethod } : {}),
		};
		this.submitting = true;
		// Disabling a focused button drops focus to the document. Keep it in the
		// form so dismissal can restore the anchor while the request is pending.
		const formAction = this.primaryAction;
		const submitRoot = this.submit instanceof ButtonWithDropdown ? this.submit.element : this.submit.domNode;
		if (submitRoot.contains(this.domNode.ownerDocument.activeElement)) { this.cancel.focus(); }
		this.submit.enabled = false;
		this.domNode.setAttribute('aria-busy', 'true');
		this.message.textContent = formAction === 'sendToChat' ? localize('sessions.changes.prSending', 'Sending request to agent…') : localize('sessions.changes.prCreating', 'Creating pull request…');
		let uncertain = false;
		try {
			if (formAction === 'sendToChat') {
				await this.options.onSendToChat!(options);
			} else {
				const message = await this.options.creation.create(options);
				this.options.onCreated(options, message);
			}
			this.preferences.update({ draft: options.draft, mergeMode: options.autoMergeMethod ? 'auto' : 'manual', mergeMethod: options.autoMergeMethod, primaryAction: formAction });
		} catch (error) {
			const chatUncertain = CreatePullRequestChatRequest.isSubmissionUncertain(error);
			uncertain = chatUncertain || error instanceof GitHubError && error.code === GitHubErrorCode.SubmissionUncertain;
			const message = uncertain && !chatUncertain
				? localize('sessions.changes.prUncertain', 'GitHub may have created the pull request. Check the repository before trying again.')
				: this.errorMessage(error);
			if (this.isDisposed) { this.options.onDetachedError(new Error(message)); }
			else {
				this.message.textContent = message;
			}
		} finally {
			this.submitting = false;
			if (!this.isDisposed) {
				this.submit.enabled = !uncertain;
				this.domNode.removeAttribute('aria-busy');
				if (!uncertain && this.domNode.ownerDocument.activeElement === this.cancel.domNode) { this.submit.focus(); }
			}
		}
	}

	private errorMessage(error: unknown): string {
		return error instanceof GitHubError
			? localize('sessions.changes.prGitHubError', 'GitHub could not prepare or create the pull request. Check your account and repository, then reopen the form.')
			: getErrorMessage(error);
	}
}
