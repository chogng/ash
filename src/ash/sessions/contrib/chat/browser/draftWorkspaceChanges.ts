import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { appendIcon } from '../../../../base/browser/ui/lxicons/lxicon.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { structuralEquals } from '../../../../base/common/equals.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { ISessionProviderScopeService } from '../../../browser/agentHost/sessionProviderScopeService.js';
import { buildAgentHostSessionWorkspace } from '../../../common/agentHostSessionWorkspace.js';
import { LOCAL_AGENT_HOST_PROVIDER_ID } from '../../../common/agentHostSessionsProvider.js';
import { hasSelectedCodeWorkspace, sessionWorkspaceUri } from '../../../common/sessionWorkspace.js';
import type { ISessionWorkspace, IUntitledChatSession } from '../../../services/sessions/common/session.js';
import { createGitComparisonEditorInput } from '../../changes/browser/gitComparisonEditorInput.js';

/** The environment card presents the uncommitted files in this draft's selected checkout. */
export class DraftWorkspaceChanges extends Disposable {
	private readonly button: HTMLButtonElement;
	private readonly label: HTMLSpanElement;
	private target: { readonly draftId: string; readonly providerId: string; readonly workspace: ISessionWorkspace; } | undefined;
	private readonly summaryRequest = this._register(new MutableDisposable());
	private readonly diffRequest = this._register(new MutableDisposable());
	private readonly refresh = this._register(new RunOnceScheduler(() => void this.readSummary(), 5000));

	constructor(
		container: HTMLElement,
		private readonly environmentTrigger: HTMLButtonElement,
		@ISessionProviderScopeService private readonly scopes: ISessionProviderScopeService,
		@IEditorService private readonly editors: IEditorService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		const document = container.ownerDocument;
		this.button = h(document, 'button', {
			className: 'ash-sessions-environment-card-trigger ash-sessions-environment-card-changes',
			attributes: { type: 'button' },
		});
		this.button.hidden = true;
		appendIcon(Lxicon.diff, this.button);
		this.label = h(document, 'span');
		this.button.append(this.label);
		container.append(this.button);
		this._register(addDisposableListener(this.button, 'click', () => void this.openDiff()));
		this._register(toDisposable(() => this.button.remove()));
	}

	update(draft: IUntitledChatSession | undefined): void {
		const source = draft?.workspace;
		const workspace = draft && hasSelectedCodeWorkspace(draft)
			&& source && (source.type === 'local' || source.type === 'ssh' || source.type === 'remote')
			? buildAgentHostSessionWorkspace(source) : undefined;
		const target = draft && workspace ? { draftId: draft.untitledSessionId, providerId: draft.providerId ?? LOCAL_AGENT_HOST_PROVIDER_ID, workspace } : undefined;
		if (structuralEquals(this.target, target)) return;
		this.target = target;
		this.summaryRequest.clear();
		this.diffRequest.clear();
		this.refresh.cancel();
		this.setCount(0);
		if (target) this.refresh.schedule(0);
	}

	private setCount(count: number): void {
		if (count === 0) {
			if (this.button === this.button.ownerDocument.activeElement) this.environmentTrigger.focus();
			this.button.hidden = true;
			return;
		}
		const label = localize({ bundle: 'ash.sessions', key: 'sessions.environment.reviewUncommitted' }, 'Uncommitted Changes ({0})', count);
		if (this.label.textContent !== label) this.label.textContent = label;
		this.button.hidden = false;
	}

	private async readSummary(): Promise<void> {
		const target = this.target;
		if (!target) return;
		const controller = new AbortController();
		this.summaryRequest.value = toDisposable(() => controller.abort());
		try {
			const scope = this.scopes.getProviderScope(target.providerId);
			const result = await scope.services.host.localGit.readWorktreeChanges(target.workspace.root, 'summary', controller.signal);
			if (controller.signal.aborted) return;
			scope.assertCurrent();
			if (result.kind === 'summary') this.setCount(result.files);
		} catch {
			if (!controller.signal.aborted) this.setCount(0);
		} finally {
			if (!controller.signal.aborted) this.refresh.schedule();
		}
	}

	private async openDiff(): Promise<void> {
		const target = this.target;
		if (!target || this.button.hidden || this.diffRequest.value) return;
		// The diff returns a fresh count. An older summary must not overwrite it.
		this.summaryRequest.clear();
		this.refresh.cancel();
		const controller = new AbortController();
		const request = this.diffRequest.value = toDisposable(() => controller.abort());
		try {
			const scope = this.scopes.getProviderScope(target.providerId);
			const result = await scope.services.host.localGit.readWorktreeChanges(target.workspace.root, 'diff', controller.signal);
			if (controller.signal.aborted || result.kind !== 'diff') return;
			scope.assertCurrent();
			this.setCount(result.files.length);
			if (result.files.length === 0) return;
			const root = sessionWorkspaceUri(target.workspace);
			const source = URI.from({ scheme: 'ash-worktree-git-diff', authority: root.authority, path: root.path });
			const input = createGitComparisonEditorInput(source, root, result.files, localize('sessions.changes.uncommittedChanges', 'Uncommitted Changes'));
			await this.editors.openEditor(input, { pinned: true, forceReload: true });
		} catch (error) {
			if (!controller.signal.aborted && !isCancellationError(error)) this.notifications.error(error instanceof Error ? error : String(error));
		} finally {
			if (this.diffRequest.value === request) {
				this.diffRequest.clear();
				this.refresh.schedule();
			}
		}
	}
}
