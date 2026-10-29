import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { autorun, observableSignalFromEvent } from '../../../../base/common/observable.js';
import { IBrowserViewService } from '../../../../platform/browserView/common/browserView.js';
import type { IWorkbenchContribution } from '../../../../workbench/common/contributions.js';
import type { BrowserEditorInput } from '../../../../workbench/contrib/browserView/common/browserEditorInput.js';
import { IBrowserViewWorkbenchService, type IBrowserViewFilterContext } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { ISessionsService, type SessionsViewSelection } from '../../../services/sessions/browser/sessionsService.js';
import type { AgentTreeNode } from '../../../services/sessions/common/session.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';

type SessionReference = { readonly kind: 'session' | 'untitled'; readonly id: string; };

/** Session policy for shared browser inputs. Main retains ownership of pages and access grants. */
export class SessionBrowserViewController extends Disposable implements IWorkbenchContribution {
	public static readonly ID = 'workbench.contrib.sessionBrowserViewController';
	private readonly ownership = new Map<string, SessionReference>();
	private readonly closing = new Map<string, Promise<void>>();
	private readonly contextChanges = this._register(new Emitter<void>());

	constructor(
		@ISessionsManagementService private readonly management: ISessionsManagementService,
		@ISessionsService private readonly sessions: ISessionsService,
		@IBrowserViewWorkbenchService private readonly browsers: IBrowserViewWorkbenchService,
		@IBrowserViewService private readonly pages: IBrowserViewService,
	) {
		super();
		this._register(browsers.registerContextualFilter({
			include: (input, context) => this.includes(input, context),
			onDidChange: this.contextChanges.event,
		}));
		this._register(browsers.registerOpenHandler({
			shouldOpenEditor: (input, owner) => {
				this.reconcile();
				// Agent pages discovered during catalog loading must not enter an unrelated working set.
				if (owner.type === 'agent' && management.state === 'loading') { return false; }
				return this.includes(input, {});
			},
		}));
		this._register(browsers.onDidChangeBrowserViews(() => this.reconcile()));
		const catalogChanges = observableSignalFromEvent(this, management.onDidChange);
		this._register(autorun(reader => {
			catalogChanges.read(reader);
			management.materializedSessions.read(reader);
			sessions.getSelection(reader);
			this.reconcile();
			this.contextChanges.fire();
		}));
	}

	public async onWorkspaceRestored(): Promise<void> {
		await this.browsers.initialize();
		if (this.isDisposed) { return; }
		this.reconcile();
		await Promise.all(this.closing.values());
	}

	private reference(selection: SessionsViewSelection | undefined): SessionReference | undefined {
		if (!selection) { return undefined; }
		return selection.kind === 'session'
			? { kind: 'session', id: selection.active.session.sessionId }
			: { kind: 'untitled', id: selection.session.untitledSessionId };
	}

	private findSession(ownerId: string): SessionReference | undefined {
		const session = this.management.sessions.find(candidate => candidate.sessionId === ownerId
			|| candidate.chats.some(chat => chat.threadId === ownerId)
			|| this.hasThread(candidate.agentTree ?? [], ownerId));
		return session ? { kind: 'session', id: session.sessionId } : undefined;
	}

	private hasThread(nodes: readonly AgentTreeNode[], threadId: string): boolean {
		return nodes.some(node => node.threadId === threadId || this.hasThread(node.children, threadId));
	}

	private owner(input: BrowserEditorInput): SessionReference | undefined {
		const pageOwner = input.model?.info.owner;
		const resolved = pageOwner?.type === 'agent' ? this.findSession(pageOwner.sessionId) : undefined;
		let reference = resolved ?? this.ownership.get(input.id);
		if (!reference && pageOwner?.type === 'user') { reference = this.reference(this.sessions.activeSelection); }
		if (reference?.kind === 'untitled') {
			const created = this.management.materializedSessions.get().get(reference.id);
			if (created) { reference = { kind: 'session', id: created.sessionId }; }
		}
		if (reference) { this.ownership.set(input.id, reference); }
		return reference;
	}

	private includes(input: BrowserEditorInput, context: IBrowserViewFilterContext): boolean {
		if (this.closing.has(input.id)) { return false; }
		const owner = this.owner(input);
		if (!owner) { return true; }
		const active = context.activeSessionId === undefined
			? this.reference(this.sessions.activeSelection)
			: this.findSession(context.activeSessionId);
		return owner.kind === active?.kind && owner.id === active.id;
	}

	private reconcile(): void {
		if (this.isDisposed) { return; }
		const known = this.browsers.getKnownBrowserViews();
		for (const id of this.ownership.keys()) {
			if (!known.has(id)) { this.ownership.delete(id); }
		}
		for (const input of known.values()) {
			const owner = this.owner(input);
			// A failed or incomplete catalog cannot establish that a session was removed.
			if (!owner || this.management.state !== 'ready' || this.closing.has(input.id)) { continue; }
			const live = owner.kind === 'session'
				? this.management.sessions.some(session => session.sessionId === owner.id && session.status === 'active')
				: this.management.untitledSessions.some(session => session.untitledSessionId === owner.id);
			if (live) { continue; }
			// Queue the command before invoking Main: its close notification can arrive synchronously.
			const closing = Promise.resolve().then(() => {
				if (!this.isDisposed && this.browsers.getKnownBrowserViews().get(input.id) === input) {
					return this.pages.destroyBrowserView(input.id);
				}
			}).catch(error => {
				if (!this.isDisposed) { console.error('Failed to close session browser page', error); }
			}).finally(() => { this.closing.delete(input.id); });
			this.closing.set(input.id, closing);
		}
	}

	protected override disposeCore(): void {
		// Window disposal detaches presentation; it does not archive sessions or destroy surviving Main pages.
		this.ownership.clear();
		super.disposeCore();
	}
}
