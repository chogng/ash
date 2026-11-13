import { h } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { equals } from '../../../../base/common/arrays.js';
import { decodeBase64 } from '../../../../base/common/buffer.js';
import { getMediaOrTextMime } from '../../../../base/common/mime.js';
import { getErrorMessage, isCancellationError } from '../../../../base/common/errors.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { createUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { IAgentThreadService } from '../../../../platform/agentHost/common/agentService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import type { IChatWidgetModel } from '../../../../workbench/contrib/chat/browser/widget/chatWidget.js';
import { IChatService } from '../../../../workbench/services/chat/common/chatService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { chatInputStackSlotClass, ChatInputStackSlot, setChatInputStackSlot } from '../../../../workbench/contrib/chat/browser/widget/input/chatInputStack.js';
import type { ChatInputPart } from '../../../../workbench/contrib/chat/browser/widget/input/chatInputPart.js';
import type { ISessionArtifact } from '../../../services/sessions/common/session.js';
import { readCapturedTurnFile } from '../../../browser/turnMultiDiffSource.js';
import { parseSessionIdentity } from '../../../services/sessions/common/sessionIdentity.js';
import { LOCAL_AGENT_HOST_PROVIDER_ID } from '../../../common/agentHostSessionsProvider.js';
import { IGitHubService } from '../../github/browser/githubService.js';
import { PullRequestFollowUpWidget } from '../../github/browser/pullRequestFollowUpWidget.js';
import { getPullRequestLabel } from '../../github/common/types.js';
import { ArtifactDetailsContextView } from './artifactDetailsContextView.js';

export interface SessionArtifactSource {
	readonly artifacts?: readonly ISessionArtifact[];
}

export function getSessionArtifactsAccessibilityHelp(): string {
	return localize({ bundle: 'ash.artifacts', key: 'sessions.artifacts.conversationHelp' }, 'Use Tab to reach Artifacts above the message input. Press Enter or Space to list the results of this conversation. Use the arrow keys to select a result and Enter to open it. Use the pull request action button to review available operations. Escape closes the list and returns focus to Artifacts.');
}

/** Shows the focused conversation's outputs and opens them through their resource owner. */
export class SessionArtifacts extends Disposable {
	private readonly element: HTMLElement;
	private readonly button: Button;
	private readonly picker = this._register(new MutableDisposable<DisposableStore>());
	private readonly watching = this._register(new MutableDisposable());
	private readonly details: ArtifactDetailsContextView;
	private opening: AbortController | undefined;
	private pullRequestAction: AbortController | undefined;
	private watchedSession: string | undefined;
	private rendered: readonly ISessionArtifact[] = [];

	constructor(
		private readonly input: Pick<ChatInputPart, 'element' | 'composerForm' | 'focus'>,
		private readonly model: Pick<IChatWidgetModel, 'onDidChange' | 'onDidChangeComposer' | 'onDidChangePresentation' | 'sessionId' | 'threadId' | 'thread' | 'items' | 'readResponseResource'> & SessionArtifactSource,
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@IOpenerService private readonly opener: IOpenerService,
		@INotificationService private readonly notifications: INotificationService,
		@IEditorService private readonly editors: IEditorService,
		@IAgentThreadService private readonly threads: IAgentThreadService,
		@IChatService private readonly chat: IChatService,
		@IGitHubService private readonly github: IGitHubService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
	) {
		super();
		this.element = h(input.element.ownerDocument, 'div', { className: chatInputStackSlotClass });
		input.composerForm.before(this.element);
		this._register(toDisposable(() => {
			setChatInputStackSlot(this.element, ChatInputStackSlot.Empty);
			this.element.remove();
		}));
		const label = localize({ bundle: 'ash.artifacts', key: 'sessions.artifacts.conversation' }, 'Artifacts');
		this.button = this._register(new Button(this.element, {
			...defaultButtonStyles, label, icon: Lxicon.files, presentation: 'secondary', size: 'small',
			onClick: () => this.show(),
		}));
		this.button.domNode.setAttribute('aria-haspopup', 'dialog');
		this.button.domNode.setAttribute('aria-expanded', 'false');
		this.details = this._register(instantiation.createInstance(ArtifactDetailsContextView, this.button.domNode));
		this._register((model.onDidChangePresentation ?? model.onDidChange)(update => {
			if (!update) this.render();
		}));
		this._register(github.onDidChange(() => this.render()));
		const retire = () => {
			this.picker.clear();
			this.details.close();
			this.opening?.abort();
			this.pullRequestAction?.abort();
		};
		this._register(model.onDidChangeComposer(retire));
		this._register(toDisposable(retire));
		this._register(AccessibleViewRegistry.register({
			name: `sessionArtifacts-${createUuid()}`, type: AccessibleViewType.View, priority: 95,
			getProvider: () => this.button.hasFocus() ? new AccessibleContentProvider(
				AccessibleViewProviderId.SessionsChat, { type: AccessibleViewType.View },
				() => this.rendered.map(artifact => artifact.label).join('\n'),
				() => { if (!this.isDisposed && this.rendered.length) this.button.focus(); },
				AccessibilityVerbositySettingId.Chat,
			) : undefined,
		}));
		this.render();
	}

	private render(): void {
		const { sessionId, threadId } = this.model;
		if (sessionId !== this.watchedSession) {
			this.watchedSession = sessionId;
			this.watching.value = sessionId ? this.github.watchSessionPullRequests([sessionId]) : undefined;
		}
		const artifacts = [...this.model.artifacts ?? []];
		if (sessionId && threadId) {
			const backendThread = parseSessionIdentity(threadId, LOCAL_AGENT_HOST_PROVIDER_ID).backendSessionId;
			for (const request of this.github.getSessionPullRequests(sessionId)) {
				const record = request.artifact;
				if (!record?.isArtifact || (record.origin ? record.origin.chat !== backendThread : this.model.thread?.origin.type !== 'root')) continue;
				artifacts.push({ id: record.id, kind: 'pullRequest', label: getPullRequestLabel(request), uri: request.uri, sessionId });
			}
		}
		const unchanged = equals(this.rendered, artifacts, (a, b) => a.id === b.id && a.label === b.label && a.uri.toString() === b.uri.toString());
		this.rendered = artifacts;
		if (unchanged) return;
		this.picker.clear();
		if (!artifacts.length && this.button.hasFocus()) this.input.focus();
		setChatInputStackSlot(this.element, artifacts.length ? ChatInputStackSlot.Standalone : ChatInputStackSlot.Empty);
	}

	private show(): void {
		if (this.picker.value || !this.rendered.length) return;
		const lifetime = new DisposableStore();
		this.picker.value = lifetime;
		const picker = lifetime.add(this.quickInput.createQuickPick<IQuickPickItem & { readonly artifact: ISessionArtifact; }>());
		picker.anchor = this.button.domNode;
		picker.ariaLabel = this.button.label;
		picker.placeholder = localize({ bundle: 'ash.artifacts', key: 'sessions.artifacts.findConversationFile' }, 'Find a result in this conversation');
		picker.sortByLabel = false;
		const pullRequestActions = { id: 'actions', label: localize('sessions.github.artifactActions', 'PR Actions'), iconClass: ThemeIcon.asClassName(Lxicon.gear) };
		const kinds = [
			['plan', localize({ bundle: 'ash.artifacts', key: 'sessions.artifacts.plans' }, 'Plans')],
			['image', localize({ bundle: 'ash.artifacts', key: 'sessions.artifacts.images' }, 'Images')],
			['file', localize({ bundle: 'ash.artifacts', key: 'sessions.artifacts.files' }, 'Files')],
			['pullRequest', localize({ bundle: 'ash.artifacts', key: 'sessions.artifacts.pullRequests' }, 'Pull Requests')],
		] as const;
		picker.items = kinds.flatMap(([kind, label]) => {
			const entries = this.rendered.filter(artifact => artifact.kind === kind).map(artifact => ({
				id: artifact.id, label: artifact.label, ariaLabel: artifact.label, artifact,
				buttons: artifact.kind === 'pullRequest' && this.github.getSessionPullRequests(artifact.sessionId).some(request =>
					request.artifact?.id === artifact.id && request.state === 'open') ? [pullRequestActions] : undefined,
			}));
			return entries.length ? [{ type: 'separator' as const, presentation: 'section' as const, label }, ...entries] : [];
		});
		lifetime.add(picker.onDidHide(() => this.picker.clear()));
		lifetime.add(picker.onDidAccept(() => {
			const artifact = this.rendered.find(artifact => artifact.id === picker.selectedItems[0]?.id);
			if (!artifact) return;
			picker.hide();
			void this.open(artifact);
		}));
		lifetime.add(picker.onDidTriggerItemButton(({ item }) => {
			const artifact = item.artifact;
			if (artifact.kind !== 'pullRequest') return;
			const request = this.github.getSessionPullRequests(artifact.sessionId).find(request => request.artifact?.id === artifact.id);
			const threadId = this.model.threadId;
			if (!request || !threadId) return;
			picker.hide();
			this.pullRequestAction?.abort();
			const controller = this.pullRequestAction = new AbortController();
			void this.github.invokePullRequestArtifact(artifact.sessionId, request, (binding, token) =>
				this.details.choose(binding, (container, cardState) => this.instantiation.createInstance(PullRequestFollowUpWidget, container, {
					sessionId: artifact.sessionId, id: artifact.id, cardState, threadId,
				}), token), threadId, controller.signal).catch(error => {
					if (!controller.signal.aborted && !isCancellationError(error)) this.notifications.error(error);
				}).finally(() => { if (this.pullRequestAction === controller) this.pullRequestAction = undefined; });
		}));
		this.button.domNode.setAttribute('aria-expanded', 'true');
		lifetime.add(toDisposable(() => this.button.domNode.setAttribute('aria-expanded', 'false')));
		picker.show();
	}

	private async open(artifact: ISessionArtifact): Promise<void> {
		this.opening?.abort();
		const controller = this.opening = new AbortController();
		const { signal } = controller;
		try {
			if (artifact.kind === 'pullRequest') {
				await this.editors.openEditor({ resource: artifact.uri.with({ scheme: 'ash-github' }), label: artifact.label, readOnly: true, showBreadcrumbs: false });
				return;
			}
			const { source, uri: resource, label } = artifact;
			if (!source) {
				await this.opener.open(resource, { fromUserGesture: true });
				return;
			}
			let initialText: string | undefined;
			let initialBytes: Uint8Array | undefined;
			let contentType: string | undefined;
			switch (source.kind) {
				case 'text':
					initialText = source.text;
					break;
				case 'capture':
					initialText = (await readCapturedTurnFile(this.chat, source.change, signal)).after;
					break;
				case 'attachment':
				case 'toolResource': {
					const result = source.kind === 'attachment' ? await this.threads.readAttachment(source.coordinate, signal)
						: await this.threads.readToolResource(source.coordinate, signal);
					initialBytes = result.bytes;
					contentType = result.mimeType || source.mimeType;
					break;
				}
				case 'bytes':
					initialBytes = source.bytes;
					contentType = source.mimeType;
					break;
				case 'dataImage':
					initialBytes = decodeBase64(source.data).buffer;
					contentType = source.mimeType;
					break;
				case 'response': {
					const item = this.model.items.find(item => item.id === source.itemId);
					const blob = item && await this.model.readResponseResource?.(item, resource, signal);
					if (!blob) return;
					initialBytes = new Uint8Array(await blob.arrayBuffer());
					contentType = blob.type && blob.type !== 'application/octet-stream' ? blob.type : source.mimeType || getMediaOrTextMime(label);
					break;
				}
			}
			if (signal.aborted || this.isDisposed) return;
			if (initialBytes && /^(?:text\/|application\/(?:json|xml)(?:;|$))/iu.test(contentType ?? '')) {
				initialText = new TextDecoder().decode(initialBytes);
				initialBytes = undefined;
			}
			await this.editors.openEditor({ resource, label, initialText, initialBytes, contentType, readOnly: true, showBreadcrumbs: false });
		} catch (error) {
			if (!signal.aborted && !isCancellationError(error)) this.notifications.error(getErrorMessage(error));
		} finally {
			if (this.opening === controller) this.opening = undefined;
		}
	}
}
