import { h, type IDimension } from '../../../../base/browser/dom.js';
import { DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ConfirmResult } from '../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import type { IResourceEditorInput } from '../../../../workbench/common/editor.js';
import type { SessionsViewSelection } from '../../../services/sessions/browser/sessionsService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { NewChatView } from './chatView.js';
import { SessionSideChatEditorInput } from './sessionSideChatEditorInput.js';

export class SessionSideChatEditor extends EditorPane {
	static readonly ID = 'sessions.editor.sideChat';
	readonly id = SessionSideChatEditor.ID;
	private element!: HTMLElement;
	private view: NewChatView | undefined;
	private readonly mount = this._register(new MutableDisposable<DisposableStore>());

	constructor(
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@ISessionsManagementService private readonly sessions: ISessionsManagementService,
		@ICommandService private readonly commands: ICommandService,
		@INotificationService private readonly notifications: INotificationService,
		@IThemeService theme: IThemeService,
		@IStorageService storage: IStorageService,
	) {
		super(SessionSideChatEditor.ID, theme, storage);
	}

	override create(parent: HTMLElement): void {
		this.element = h(parent.ownerDocument, 'div', { className: 'ash-session-side-chat-editor' });
		parent.append(this.element);
		super.create(this.element);
	}

	override async setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		if (!(input instanceof SessionSideChatEditorInput)) throw new TypeError('Invalid Side Chat editor input');
		this.clearInput();
		const resources = new DisposableStore();
		this.mount.value = resources;
		try {
			const reference = input.reference;
			let selection: SessionsViewSelection;
			if ('draft' in reference) {
				const draft = this.sessions.untitledSessions.find(session => session.untitledSessionId === reference.draft.untitledSessionId);
				if (!draft) this.sessions.restoreUntitledSession(reference.draft);
				selection = { kind: 'untitled', session: draft ?? reference.draft };
			} else {
				await this.sessions.prepareThread(reference.sessionId, reference.threadId);
				signal.throwIfAborted();
				if (this.mount.value !== resources) return;
				const session = this.sessions.sessions.find(candidate => candidate.sessionId === reference.sessionId);
				if (!session) throw new Error(localize('chatSession.target.invalid', 'Choose a valid session.'));
				selection = { kind: 'session', active: { session, threadId: reference.threadId } };
			}
			const view = resources.add(this.instantiation.createInstance(NewChatView, this.element.ownerDocument,
				`side-chat-${this.group?.id}-${input.resource.path.slice(1)}`, selection,
				() => { void this.commands.executeCommand('ash.sessions.openSideChat').catch(error => this.notifications.error(error)); },
				() => { }));
			view.render(this.element);
			this.view = view;
			view.setVisible(this.isVisible());
			// Keep only the reference needed to restore the tab. The model owns the conversation and its draft.
			const updateReference = () => {
				const active = view.model.selectedSession;
				if (active.kind === 'session') {
					input.reference = { sessionId: active.active.session.sessionId, threadId: active.active.threadId };
				} else {
					const draft = this.sessions.untitledSessions.find(session => session.untitledSessionId === active.session.untitledSessionId);
					if (draft) input.reference = { draft };
				}
			};
			resources.add(view.model.onDidChange(updateReference));
			resources.add(this.sessions.onDidChange(updateReference));
			const closeHandler = input.closeHandler = {
				showConfirm: () => true,
				confirm: async () => {
					await view.captureDraft();
					updateReference();
					return ConfirmResult.DONT_SAVE;
				},
			};
			resources.add(toDisposable(() => {
				if (input.closeHandler === closeHandler) input.closeHandler = undefined;
			}));
		} catch (error) {
			if (this.mount.value === resources) this.clearInput();
			throw error;
		}
	}

	override clearInput(): void {
		this.view = undefined;
		this.mount.clear();
	}

	override setVisible(visible: boolean): void {
		super.setVisible(visible);
		this.view?.setVisible(visible);
	}

	override layout(_dimension: IDimension): void { }
	override focus(): void { this.view?.focus(); }
}
