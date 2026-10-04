import './media/issueReporter.css';
import { addDisposableListener, h, type IDimension } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputbox.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IAccessibleViewService, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { IAccountService, type AccountState } from '../../../../platform/accounts/common/accountService.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IGitHubConnectionService } from '../../../services/accounts/common/gitHubConnectionService.js';
import type { EditorInput } from '../../../services/editor/common/editorService.js';
import { EditorPaneVisibility, type IEditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IIssueFormService, IssueType, type IssueReporterState } from '../common/issue.js';
import { issueReporterEditorId } from './issueService.js';

/** The editor owns its DOM; the form service keeps the draft through tab closure. */
export class IssueReporterEditorPane extends Disposable implements IEditorPane {
	readonly id = issueReporterEditorId;
	private domNode!: HTMLDivElement;
	private title!: InputBox;
	private description!: HTMLTextAreaElement;
	private type!: HTMLSelectElement;
	private system!: HTMLInputElement;
	private extensions!: HTMLInputElement;
	private preview!: HTMLPreElement;
	private target!: HTMLAnchorElement;
	private account!: HTMLParagraphElement;
	private status!: HTMLParagraphElement;
	private results!: HTMLUListElement;
	private search!: Button;
	private cancel!: Button;
	private submit!: Button;
	private signIn!: Button;
	private newReport!: Button;
	private created!: HTMLAnchorElement;
	private shownIssues: IssueReporterState['similarIssues'] | undefined;
	private readonly resultListeners = this._register(new DisposableStore());

	constructor(
		@IIssueFormService private readonly form: IIssueFormService,
		@IAccountService private readonly accounts: IAccountService,
		@IGitHubConnectionService private readonly github: IGitHubConnectionService,
		@IOpenerService private readonly opener: IOpenerService,
		@IAccessibleViewService private readonly accessibleView: IAccessibleViewService,
	) { super(); }

	create(parent: HTMLElement): void {
		const document = parent.ownerDocument;
		this.domNode = h(document, 'div');
		this.domNode.className = 'ash-issue-reporter';
		parent.append(this.domNode);
		this._register(toDisposable(() => { this.form.cancelSearch(); this.domNode.remove(); }));
		const content = h(document, 'div');
		content.className = 'issue-reporter-content';
		this.domNode.append(content);
		content.append(h(document, 'h1', localize('issue.title', 'Report an issue')));
		this.target = h(document, 'a');
		this.target.className = 'issue-reporter-target';
		content.append(this.target);
		this.openLink(this.target);
		const typeLabel = this.label(content, localize('issue.type', 'Issue type'));
		this.type = h(document, 'select');
		for (const [value, text] of [[IssueType.Bug, localize('issue.bug', 'Bug')], [IssueType.PerformanceIssue, localize('issue.performance', 'Performance issue')], [IssueType.FeatureRequest, localize('issue.feature', 'Feature request')]] as const) {
			const option = h(document, 'option', text); option.value = String(value); this.type.append(option);
		}
		typeLabel.append(this.type);
		this._register(addDisposableListener(this.type, 'change', () => this.form.update({ issueType: Number(this.type.value) })));
		const titleLabel = this.label(content, localize('issue.reportTitle', 'Title'));
		this.title = this._register(new InputBox(titleLabel, { presentation: 'field', ariaLabel: localize('issue.reportTitle', 'Title') }));
		this.title.inputElement.maxLength = 256;
		this._register(this.title.onDidChange(issueTitle => this.form.update({ issueTitle })));
		const bodyLabel = this.label(content, localize('issue.description', 'Description'));
		this.description = h(document, 'textarea');
		this.description.rows = 8;
		this.description.maxLength = 65_536;
		this.description.placeholder = localize('issue.descriptionHint', 'What happened? What did you expect? How can we reproduce it?');
		bodyLabel.append(this.description);
		this._register(addDisposableListener(this.description, 'input', () => this.form.update({ issueBody: this.description.value })));
		const diagnostics = h(document, 'div');
		diagnostics.className = 'issue-reporter-diagnostics';
		content.append(diagnostics);
		this.system = this.checkbox(diagnostics, localize('issue.includeSystem', 'Include system information'), checked => this.form.update({ includeSystemInfo: checked }));
		this.extensions = this.checkbox(diagnostics, localize('issue.includeExtensions', 'Include installed extensions'), checked => this.form.update({ includeExtensions: checked }));
		const details = h(document, 'details');
		details.append(h(document, 'summary', localize('issue.preview', 'Preview the report that will be submitted')));
		this.preview = h(document, 'pre');
		this.preview.tabIndex = 0;
		details.append(this.preview);
		content.append(details);
		const searchRow = h(document, 'div'); searchRow.className = 'issue-reporter-actions'; content.append(searchRow);
		this.search = this._register(new Button(searchRow, { label: localize('issue.search', 'Search similar issues'), onClick: () => void this.form.searchGitHubIssues() }));
		this.cancel = this._register(new Button(searchRow, { label: localize('issue.cancelSearch', 'Cancel search'), onClick: () => this.form.cancelSearch() }));
		this.results = h(document, 'ul');
		this.results.className = 'issue-reporter-results';
		this.results.setAttribute('aria-label', localize('issue.similarIssues', 'Similar issues'));
		content.append(this.results);
		this.account = h(document, 'p'); content.append(this.account);
		const actions = h(document, 'div'); actions.className = 'issue-reporter-actions'; content.append(actions);
		this.signIn = this._register(new Button(actions, { label: localize('issue.signIn', 'Sign in to GitHub'), onClick: () => {
			this.signIn.enabled = false;
			void this.github.connect().catch(() => { if (!this.isDisposed) { this.status.textContent = localize('issue.signInFailed', 'GitHub sign-in failed. Your report remains here.'); } }).finally(() => { if (!this.isDisposed) { this.signIn.enabled = true; } });
		} }));
		this.submit = this._register(new Button(actions, { label: localize('issue.submit', 'Submit to GitHub'), presentation: 'primary', onClick: () => void this.form.submitIssue() }));
		this.newReport = this._register(new Button(actions, { label: localize('issue.newReport', 'New report'), onClick: () => { this.form.reset(); this.title.focus(); } }));
		this.created = h(document, 'a'); content.append(this.created); this.openLink(this.created);
		this.status = h(document, 'p'); this.status.className = 'issue-reporter-status'; this.status.setAttribute('role', 'status'); content.append(this.status);
		const hint = h(document, 'p'); hint.className = 'issue-reporter-hint';
		hint.textContent = this.accessibleView.getOpenAriaHint(AccessibilityVerbositySettingId.IssueReporter) ?? '';
		content.append(hint);
		// A login event can arrive before the initial account read completes.
		let receivedAccountEvent = false;
		this._register(this.accounts.onDidChangeAccounts(state => { receivedAccountEvent = true; this.renderAccount(state); }));
		this._register(this.form.onDidChange(state => this.render(state)));
		void this.accounts.read().then(state => { if (!this.isDisposed && !receivedAccountEvent) { this.renderAccount(state); } }, () => { if (!this.isDisposed && !receivedAccountEvent) { this.account.textContent = localize('issue.accountUnavailable', 'GitHub account information is unavailable.'); } });
		this.render(this.form.state);
	}

	async setInput(_input: EditorInput, signal: AbortSignal): Promise<void> {
		if (signal.aborted) { throw new CancellationError(); }
		await this.form.initialize({});
		if (signal.aborted) { throw new CancellationError(); }
	}
	getControl(): HTMLElement { return this.domNode; }
	clearInput(): void { this.form.cancelSearch(); }
	layout(dimension: IDimension): void { this.domNode.style.width = `${dimension.width}px`; this.domNode.style.height = `${dimension.height}px`; }
	setVisible(visibility: EditorPaneVisibility): void { this.domNode.hidden = visibility === EditorPaneVisibility.Hidden; }
	focus(): void { this.title.focus(); }

	private render(data: IssueReporterState): void {
		const locked = data.submitting || data.createdIssue !== undefined;
		// InputBox.value emits a user-change event; rendering must not feed it back into the draft.
		if (this.title.value !== data.issueTitle) { this.title.inputElement.value = data.issueTitle; }
		if (this.description.value !== data.issueBody) { this.description.value = data.issueBody; }
		this.title.enabled = !locked;
		this.description.disabled = locked;
		this.type.value = String(data.issueType); this.type.disabled = locked;
		this.system.checked = data.includeSystemInfo; this.system.disabled = locked;
		this.extensions.checked = data.includeExtensions; this.extensions.disabled = locked;
		this.preview.textContent = this.form.serialize();
		this.target.textContent = data.context?.reportIssueUrl ?? localize('issue.loadingTarget', 'Loading report destination…');
		if (data.context) { this.target.href = data.context.reportIssueUrl; }
		this.search.enabled = !!data.context && !!data.issueTitle.trim() && !data.searching && !locked;
		this.cancel.hidden = !data.searching;
		this.submit.enabled = !!data.context && !!data.issueTitle.trim() && !!data.issueBody.trim() && !locked;
		this.newReport.hidden = !data.createdIssue;
		this.submit.label = data.submitting ? localize('issue.submitting', 'Submitting…') : localize('issue.submit', 'Submit to GitHub');
		this.created.hidden = !data.createdIssue;
		if (data.createdIssue) { this.created.href = data.createdIssue.html_url; this.created.textContent = localize('issue.created', 'Open issue #{0}', data.createdIssue.number); }
		const message = data.error ?? (data.loading ? localize('issue.loading', 'Loading diagnostics…') : data.searching ? localize('issue.searching', 'Searching GitHub…') : data.createdIssue ? localize('issue.submitted', 'Your issue was submitted.') : data.searchedTitle ? localize('issue.searchCount', '{0} similar issues found.', data.similarIssues.length) : '');
		if (this.status.textContent !== message) { this.status.textContent = message; }
		this.status.classList.toggle('error', !!data.error);
		if (this.shownIssues !== data.similarIssues) {
			this.shownIssues = data.similarIssues;
			this.resultListeners.clear(); this.results.replaceChildren();
			for (const issue of data.similarIssues) {
				const item = h(this.domNode.ownerDocument, 'li');
				const state = issue.state === 'open' ? localize('issue.open', 'open') : localize('issue.closed', 'closed');
				const link = h(this.domNode.ownerDocument, 'a', localize('issue.similarIssue', '{0} ({1})', issue.title, state)); link.href = issue.html_url;
				item.append(link); this.results.append(item); this.openLink(link, this.resultListeners);
			}
		}
	}

	private renderAccount(state: AccountState): void {
		const account = state.accounts.find(account => account.provider === 'github' && account.status === 'ready');
		this.account.textContent = account ? localize('issue.account', 'Submitting as {0}', account.displayName ?? account.accountId) : localize('issue.loginHint', 'You can search without signing in. Sign in to GitHub to submit.');
		this.signIn.hidden = !!account;
	}

	private label(container: HTMLElement, text: string): HTMLLabelElement {
		const label = h(container.ownerDocument, 'label'); label.className = 'issue-reporter-field'; label.append(h(container.ownerDocument, 'span', text)); container.append(label); return label;
	}
	private checkbox(container: HTMLElement, text: string, change: (checked: boolean) => void): HTMLInputElement {
		const label = h(container.ownerDocument, 'label'); const input = h(container.ownerDocument, 'input'); input.type = 'checkbox'; label.append(input, text); container.append(label);
		this._register(addDisposableListener(input, 'change', () => change(input.checked))); return input;
	}
	private openLink(link: HTMLAnchorElement, listeners: DisposableStore = this._store): void {
		listeners.add(addDisposableListener(link, 'click', event => {
			event.preventDefault();
			if (!link.hasAttribute('href')) { return; }
			void this.opener.open(link.href, { openExternal: true, fromUserGesture: true, allowContributedOpeners: true }).catch(() => { if (!this.isDisposed) { this.status.textContent = localize('issue.openFailed', 'Could not open the GitHub page.'); } });
		}));
	}
}
