import './docsCommentsWidget.css';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { AnchorAxisAlignment, ContextView, ContextViewHideReason } from '../../../../base/browser/ui/contextview/contextview.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputbox.js';
import { SelectBox } from '../../../../base/browser/ui/selectbox/selectbox.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { generateUuid, isUuid, parseUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { defaultInputBoxStyles, defaultSelectBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { DOCS_COMMENT_MAX_LENGTH, DocsCommentState, type DocsCommentThread } from '../common/docsComments.js';
import type { DocsCommentDraft } from './arkdown/arkdownComments.js';
import type { ArkdownEditor } from './arkdown/arkdownEditor.js';

type Composer = { readonly kind: 'new'; readonly draft?: DocsCommentDraft; }
	| { readonly kind: 'reply'; readonly threadId: string; }
	| { readonly kind: 'edit'; readonly threadId: string; readonly messageId: string; };
enum CommentFilter { Open = 'open', Resolved = 'resolved', All = 'all' }
export const DocsCommentsFocused = new RawContextKey<boolean>('docsCommentsFocus', false);

/** The sidebar owns only navigation and unsent input. Arkdown owns all saved
 * threads, anchors and transactions; switching inputs releases editor listeners. */
export class DocsCommentsWidget extends Disposable {
	private readonly root: HTMLElement;
	private readonly list: HTMLElement;
	private readonly composer: HTMLElement;
	private readonly popup: ContextView;
	private readonly quote: HTMLElement;
	private readonly input: InputBox<true>;
	private readonly post: Button;
	private readonly add: Button;
	private readonly filter: SelectBox;
	private readonly listLifetime = this._register(new DisposableStore());
	private readonly editorLifetime = this._register(new MutableDisposable<DisposableStore>());
	private editor: ArkdownEditor | undefined;
	private activeThread: string | undefined;
	private composing: Composer | undefined;
	private readonly drafts = new Map<string, string>();
	private rendered: string | undefined;
	private readonly authorId: string;
	private readonly visibilityChanged = this._register(new Emitter<boolean>());
	readonly onDidChangeVisibility = this.visibilityChanged.event;

	constructor(container: HTMLElement,
		@IStorageService storage: IStorageService,
		@INotificationService private readonly notifications: INotificationService,
		@IContextKeyService contextKeys: IContextKeyService,
	) {
		super();
		const saved = storage.get('sessions.docs.commentAuthor', StorageScope.PROFILE);
		this.authorId = isUuid(saved) ? parseUuid(saved) : generateUuid();
		if (!isUuid(saved)) storage.store('sessions.docs.commentAuthor', this.authorId, StorageScope.PROFILE, StorageTarget.MACHINE);
		const document = container.ownerDocument;
		this.root = h(document, 'aside', { className: 'ash-docs-comments', attributes: { 'aria-label': localize({ bundle: 'ash.docs', key: 'comments' }, 'Comments'), hidden: '' } });
		DocsCommentsFocused.bindTo(this._register(contextKeys.createScoped(this.root))).set(true);
		const header = h(document, 'div', { className: 'ash-docs-comments-header' }, h(document, 'h2', {}, localize({ bundle: 'ash.docs', key: 'comments' }, 'Comments')));
		this.add = this._register(new Button(header, { label: localize({ bundle: 'ash.docs', key: 'newComment' }, 'New comment'), icon: Lxicon.add, iconOnly: true, onClick: () => this.startComment() }));
		this._register(new Button(header, { label: localize({ bundle: 'ash.docs', key: 'closeComments' }, 'Close comments'), icon: Lxicon.close, iconOnly: true, onClick: () => this.hide() }));
		const filters = h(document, 'div', { className: 'ash-docs-comments-filter' });
		this.filter = this._register(new SelectBox(filters, {
			ariaLabel: localize({ bundle: 'ash.docs', key: 'filterComments' }, 'Filter comments'), presentation: 'field', selectedValue: CommentFilter.Open, options: [
				{ value: CommentFilter.Open, label: localize({ bundle: 'ash.docs', key: 'openComments' }, 'Open comments') },
				{ value: CommentFilter.Resolved, label: localize({ bundle: 'ash.docs', key: 'resolvedComments' }, 'Resolved comments') },
				{ value: CommentFilter.All, label: localize({ bundle: 'ash.docs', key: 'allComments' }, 'All comments') },
			]
		}, defaultSelectBoxStyles));
		this._register(this.filter.onDidSelect(() => this.update()));
		this.list = h(document, 'div', { className: 'ash-docs-comments-list' });
		this.composer = h(document, 'div', { className: 'ash-docs-comment-composer', attributes: { hidden: '' } });
		DocsCommentsFocused.bindTo(this._register(contextKeys.createScoped(this.composer))).set(true);
		this.popup = this._register(new ContextView(container));
		this.quote = h(document, 'blockquote', { className: 'ash-docs-comment-quote' });
		this.composer.append(this.quote);
		this.input = this._register(new InputBox(this.composer, {
			flexibleHeight: true, flexibleMaxHeight: 180, presentation: 'field', inputBoxStyles: defaultInputBoxStyles,
			ariaLabel: localize({ bundle: 'ash.docs', key: 'commentText' }, 'Comment text'), placeholder: localize({ bundle: 'ash.docs', key: 'writeComment' }, 'Write a comment…')
		}));
		this.input.inputElement.maxLength = DOCS_COMMENT_MAX_LENGTH;
		const buttons = h(document, 'div', { className: 'ash-docs-comment-composer-actions' });
		this._register(new Button(buttons, { label: localize({ bundle: 'ash.docs', key: 'cancelComment' }, 'Cancel'), presentation: 'secondary', onClick: () => this.cancel() }));
		this.post = this._register(new Button(buttons, { label: localize({ bundle: 'ash.docs', key: 'postComment' }, 'Post comment'), presentation: 'primary', enabled: false, onClick: () => this.submit() }));
		this.composer.append(buttons);
		this._register(this.input.onDidChange(() => this.updateComposer()));
		this._register(this.input.onDidHeightChange(() => this.popup.layout()));
		this._register(this.input.onKeyDown(event => {
			if (event.isComposing || event.key !== 'Enter' || event.shiftKey || event.altKey) return;
			event.preventDefault(); event.stopPropagation(); this.submit();
		}));
		this._register(addDisposableListener(container, 'keydown', event => {
			const target = event.target as Node;
			if (event.isComposing || (!this.root.contains(target) && !this.composer.contains(target))) return;
			if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.hide(); }
			if ((event.ctrlKey || event.metaKey) && !event.altKey && (event.code === 'KeyZ' || event.code === 'KeyY') && event.target !== this.input.inputElement) {
				event.preventDefault(); event.stopPropagation();
				if (event.shiftKey || event.code === 'KeyY') this.editor?.redo(); else this.editor?.undo();
			}
		}));
		this.root.append(header, filters, this.list, this.composer);
		container.append(this.root);
	}
	get isVisible(): boolean { return !this.root.hidden; }
	setEditor(editor: ArkdownEditor | undefined): void {
		this.closePopup();
		this.editorLifetime.clear();
		if (this.editor && !this.editor.isDisposed) this.editor.setActiveComment(undefined);
		this.editor = editor;
		this.activeThread = undefined; this.composing = undefined; this.drafts.clear(); this.input.value = ''; this.rendered = undefined;
		this.listLifetime.clear(); this.list.replaceChildren();
		this.setVisible(false);
		if (!editor) return;
		const lifetime = this.editorLifetime.value = new DisposableStore();
		lifetime.add(editor.onDidChangeMode(() => this.closePopup()));
		lifetime.add(editor.onDidChangeSelection(() => { if (this.isVisible) this.update(); }));
		lifetime.add(editor.onDidRequestComment(request => {
			if (request.threadId) this.showThread(request.threadId, request.focus === true);
			else if (!editor.comments.isReadonly) this.startComment(request.draft, request.getAnchor);
			else this.show();
		}));
	}
	show(): void { if (!this.editor) return; this.closePopup(); this.setVisible(true); this.update(); }
	hide(): void { this.closePopup(); this.filter.hide(); this.setVisible(false); this.editor?.setActiveComment(undefined); this.editor?.focus(); }
	closePopup(): void { this.popup.hide(); }
	private setVisible(visible: boolean): void {
		if (this.root.hidden === !visible) return;
		this.root.hidden = !visible;
		this.visibilityChanged.fire(visible);
	}
	private startComment(draft?: DocsCommentDraft, getAnchor?: () => DOMRect | undefined): void {
		const editor = this.editor;
		if (!editor || editor.comments.isReadonly) return;
		this.closePopup();
		this.compose({ kind: 'new', draft }); this.activeThread = undefined;
		editor.setActiveComment(undefined);
		if (getAnchor && !editor.comments.snapshot.invalid && this.showPopup(editor, getAnchor)) {
			return;
		}
		this.show();
		this.input.focus();
	}
	private showPopup(editor: ArkdownEditor, getAnchor: () => DOMRect | undefined): boolean {
		if (!getAnchor()) return false;
		this.composer.classList.add('floating');
		this.composer.setAttribute('role', 'dialog');
		this.composer.setAttribute('aria-label', localize({ bundle: 'ash.docs', key: 'addComment' }, 'Add comment'));
		this.updateComposer();
		this.popup.show({
			anchor: editor.domNode,
			getAnchor,
			anchorAxisAlignment: AnchorAxisAlignment.Horizontal,
			gap: 8,
			content: this.composer,
			presentation: 'dialog',
			onHide: reason => {
				if (this.composing) this.drafts.set(this.composerKey(this.composing), this.input.value);
				this.composing = undefined;
				this.composer.classList.remove('floating');
				this.composer.removeAttribute('role');
				this.composer.removeAttribute('aria-label');
				this.root.append(this.composer);
				this.updateComposer();
				if (reason === ContextViewHideReason.Escape) editor.focus();
			},
		});
		this.input.layout();
		this.input.focus({ preventScroll: true });
		return true;
	}
	private showThread(id: string, focus: boolean): void {
		const thread = this.editor?.comments.snapshot.threads.find(thread => thread.id === id);
		if (!thread) return;
		this.closePopup();
		// Preserve unsent input when an anchor is pressed again in the document.
		if (this.activeThread !== id || !this.composing) this.compose({ kind: 'reply', threadId: id });
		this.activeThread = id;
		if (this.filter.value !== CommentFilter.All) this.filter.value = thread.state;
		this.editor!.setActiveComment(id); this.show(); this.updateComposer();
		this.list.querySelector<HTMLElement>(`[data-comment-thread="${id}"]`)?.scrollIntoView({ block: 'nearest' });
		if (focus) {
			if (thread.state === DocsCommentState.Open && !this.editor!.comments.isReadonly) this.input.focus();
			else this.list.querySelector<HTMLElement>(`[data-comment-thread="${id}"]`)?.focus();
		}
	}
	update(): void {
		const editor = this.editor;
		if (!editor) return;
		const state = editor.comments.snapshot;
		this.add.enabled = !editor.comments.isReadonly && !state.invalid;
		const key = JSON.stringify([state.threads, [...state.anchors].map(([id, anchor]) => [id, anchor.quote]), state.invalid, editor.comments.isReadonly, this.filter.value, this.activeThread]);
		if (key !== this.rendered) {
			this.rendered = key; this.listLifetime.clear(); this.list.replaceChildren();
			const threads = state.threads.filter(thread => this.filter.value === CommentFilter.All || thread.state === this.filter.value);
			if (!threads.length || state.invalid) this.list.append(h(this.root.ownerDocument, 'p', { className: 'ash-docs-comments-empty' }, state.invalid
				? localize({ bundle: 'ash.docs', key: 'commentsInvalid' }, 'Comment data could not be read. Use Markdown source to repair the ash-comments block.')
				: localize({ bundle: 'ash.docs', key: 'noComments' }, 'No comments')));
			for (const thread of threads) this.renderThread(thread);
		}
		this.updateComposer();
	}
	private renderThread(thread: DocsCommentThread): void {
		const document = this.root.ownerDocument, editor = this.editor!;
		const card = h(document, 'article', {
			className: 'ash-docs-comment-thread', attributes: {
				tabindex: '0', 'data-comment-thread': thread.id,
				'aria-label': localize({ bundle: 'ash.docs', key: 'commentThread' }, 'Comment thread')
			}
		});
		card.classList.toggle('active', this.activeThread === thread.id);
		card.classList.toggle('resolved', thread.state === DocsCommentState.Resolved);
		const anchor = editor.comments.snapshot.anchors.get(thread.id);
		const heading = h(document, 'div', { className: 'ash-docs-comment-thread-heading' });
		const quote = this.listLifetime.add(new Button(heading, {
			label: anchor?.quote.slice(0, 180) ?? thread.quote?.slice(0, 180) ?? localize({ bundle: 'ash.docs', key: 'documentComment' }, 'Document comment'),
			ariaLabel: anchor ? localize({ bundle: 'ash.docs', key: 'showCommentAnchor' }, 'Show commented text: {0}', anchor.quote.slice(0, 180)) : undefined,
			onClick: () => { this.showThread(thread.id, false); editor.revealComment(thread.id); }
		}));
		quote.domNode.classList.add('ash-docs-comment-anchor-link');
		const resolved = thread.state === DocsCommentState.Resolved;
		this.listLifetime.add(new Button(heading, {
			label: resolved ? localize({ bundle: 'ash.docs', key: 'reopenComment' }, 'Reopen thread') : localize({ bundle: 'ash.docs', key: 'resolveComment' }, 'Resolve thread'),
			icon: resolved ? Lxicon.refresh : Lxicon.check, iconOnly: true, enabled: !editor.comments.isReadonly, onClick: () => this.run(() => {
				editor.comments.setState(thread.id, resolved ? DocsCommentState.Open : DocsCommentState.Resolved);
				status(resolved ? localize({ bundle: 'ash.docs', key: 'commentReopened' }, 'Thread reopened') : localize({ bundle: 'ash.docs', key: 'commentResolved' }, 'Thread resolved'));
			})
		}));
		this.listLifetime.add(new Button(heading, {
			label: localize({ bundle: 'ash.docs', key: 'deleteThread' }, 'Delete thread'), icon: Lxicon.trash, iconOnly: true, enabled: !editor.comments.isReadonly, onClick: () => this.run(() => {
				editor.comments.deleteThread(thread.id); if (this.activeThread === thread.id) this.cancel();
				status(localize({ bundle: 'ash.docs', key: 'commentDeleted' }, 'Comment deleted'));
			})
		}));
		card.append(heading);
		if (!anchor && thread.quote) card.append(h(document, 'div', { className: 'ash-docs-comment-state' }, localize({ bundle: 'ash.docs', key: 'commentTextRemoved' }, 'Original text removed')));
		if (resolved) card.append(h(document, 'div', { className: 'ash-docs-comment-state' }, localize({ bundle: 'ash.docs', key: 'commentResolved' }, 'Thread resolved')));
		for (const message of thread.messages) {
			const item = h(document, 'div', { className: 'ash-docs-comment-message' });
			const meta = h(document, 'div', { className: 'ash-docs-comment-meta' }, h(document, 'strong', {}, message.authorId === this.authorId
				? localize({ bundle: 'ash.docs', key: 'commentYou' }, 'You') : localize({ bundle: 'ash.docs', key: 'commentCollaborator' }, 'Collaborator')));
			const time = h(document, 'time', { attributes: { datetime: new Date(message.createdAt).toISOString() } }, new Date(message.createdAt).toLocaleString());
			meta.append(time);
			if (message.editedAt !== undefined) meta.append(h(document, 'span', {}, localize({ bundle: 'ash.docs', key: 'commentEdited' }, 'Edited')));
			const body = h(document, 'p', { className: 'ash-docs-comment-body' }, message.body);
			item.append(meta, body);
			if (!editor.comments.isReadonly) {
				const actions = h(document, 'div', { className: 'ash-docs-comment-message-actions' });
				this.listLifetime.add(new Button(actions, {
					label: localize({ bundle: 'ash.docs', key: 'editComment' }, 'Edit comment'), size: 'small', onClick: () => {
						this.activeThread = thread.id; this.compose({ kind: 'edit', threadId: thread.id, messageId: message.id }, message.body);
						this.updateComposer(); this.input.focus();
					}
				}));
				this.listLifetime.add(new Button(actions, {
					label: localize({ bundle: 'ash.docs', key: 'deleteComment' }, 'Delete comment'), size: 'small', onClick: () => this.run(() => {
						editor.comments.deleteMessage(thread.id, message.id); status(localize({ bundle: 'ash.docs', key: 'commentDeleted' }, 'Comment deleted'));
					})
				}));
				item.append(actions);
			}
			card.append(item);
		}
		if (!resolved && !editor.comments.isReadonly) this.listLifetime.add(new Button(card, { label: localize({ bundle: 'ash.docs', key: 'replyComment' }, 'Reply'), presentation: 'secondary', size: 'small', onClick: () => { this.compose({ kind: 'reply', threadId: thread.id }); this.showThread(thread.id, true); } }));
		this.list.append(card);
	}
	private updateComposer(): void {
		const current = this.composing, editor = this.editor;
		const state = editor?.comments.snapshot;
		const thread = current && current.kind !== 'new' ? state?.threads.find(thread => thread.id === current.threadId) : undefined;
		this.composer.hidden = !current || !!editor?.comments.isReadonly || !!state?.invalid
			|| current.kind !== 'new' && (!thread || current.kind === 'reply' && thread.state === DocsCommentState.Resolved);
		this.input.enabled = !!current && !editor?.comments.isReadonly && !state?.invalid && (current.kind === 'new' || !!thread && (current.kind === 'edit' || thread.state === DocsCommentState.Open));
		this.post.enabled = this.input.enabled && !!this.input.value.trim();
		this.post.label = current?.kind === 'edit' ? localize({ bundle: 'ash.docs', key: 'saveComment' }, 'Save comment') : current?.kind === 'reply'
			? localize({ bundle: 'ash.docs', key: 'replyComment' }, 'Reply') : localize({ bundle: 'ash.docs', key: 'postComment' }, 'Post comment');
		this.quote.textContent = current?.kind === 'new' ? current.draft?.quote ?? localize({ bundle: 'ash.docs', key: 'documentComment' }, 'Document comment')
			: current ? state?.anchors.get(current.threadId)?.quote ?? localize({ bundle: 'ash.docs', key: 'documentComment' }, 'Document comment') : '';
	}
	private submit(): void {
		if (!this.post.enabled || !this.composing || !this.editor) return;
		const current = this.composing, editor = this.editor, body = this.input.value;
		this.run(() => {
			const id = current.kind === 'new' ? editor.comments.create(body, this.authorId, current.draft) : current.threadId;
			if (current.kind === 'reply') editor.comments.reply(id, body, this.authorId);
			if (current.kind === 'edit') editor.comments.editMessage(id, current.messageId, body);
			this.drafts.delete(this.composerKey(current)); this.composing = undefined; this.input.value = ''; this.showThread(id, true);
			status(current.kind === 'edit' ? localize({ bundle: 'ash.docs', key: 'commentSaved' }, 'Comment saved') : localize({ bundle: 'ash.docs', key: 'commentPosted' }, 'Comment posted'));
		});
	}
	private composerKey(composer: Composer): string {
		if (composer.kind === 'new') return composer.draft ? `new:${composer.draft.version}:${composer.draft.range.start}:${composer.draft.range.end}` : 'new:document';
		return composer.kind === 'reply' ? `reply:${composer.threadId}` : `edit:${composer.threadId}:${composer.messageId}`;
	}
	private compose(next: Composer, initial = ''): void {
		const key = this.composerKey(next);
		if (this.composing && this.composerKey(this.composing) === key) return;
		if (this.composing) this.drafts.set(this.composerKey(this.composing), this.input.value);
		this.composing = next; this.input.value = this.drafts.get(key) ?? initial;
	}
	private cancel(): void {
		if (this.composing) this.drafts.delete(this.composerKey(this.composing));
		this.composing = undefined;
		this.input.value = '';
		if (this.popup.visible) {
			this.closePopup();
			this.editor?.focus();
			return;
		}
		this.update();
		this.add.focus();
	}
	private run(action: () => void): void {
		const focused = this.root.ownerDocument.activeElement;
		try {
			action(); this.update();
			if (focused && !focused.isConnected && this.isVisible) {
				const active = this.activeThread && this.list.querySelector<HTMLElement>(`[data-comment-thread="${this.activeThread}"]`);
				if (active) active.focus(); else this.add.focus();
			}
		}
		catch (error) { this.notifications.error(error instanceof Error ? error : String(error)); }
	}
	getAccessibleContent(): string {
		const state = this.editor?.comments.snapshot;
		if (!state?.threads.length) return '';
		return [localize({ bundle: 'ash.docs', key: 'comments' }, 'Comments'), ...state.threads.map(thread => [
			thread.state === DocsCommentState.Resolved ? localize({ bundle: 'ash.docs', key: 'commentResolved' }, 'Thread resolved') : localize({ bundle: 'ash.docs', key: 'openComments' }, 'Open comments'),
			state.anchors.get(thread.id)?.quote ?? localize({ bundle: 'ash.docs', key: 'documentComment' }, 'Document comment'),
			...thread.messages.map(message => localize({ bundle: 'ash.docs', key: 'commentAccessibleMessage' }, '{0}, {1}\n{2}',
				message.authorId === this.authorId ? localize({ bundle: 'ash.docs', key: 'commentYou' }, 'You') : localize({ bundle: 'ash.docs', key: 'commentCollaborator' }, 'Collaborator'),
				new Date(message.createdAt).toLocaleString(), message.body)),
		].join('\n'))].join('\n\n');
	}
	protected override disposeCore(): void { this.closePopup(); this.filter.hide(); this.root.remove(); super.disposeCore(); }
}
