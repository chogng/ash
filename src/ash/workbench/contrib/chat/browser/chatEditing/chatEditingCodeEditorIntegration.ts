import './media/chatEditingEditorOverlay.css';
import { $, addDisposableListener } from '../../../../../base/browser/dom.js';
import { status } from '../../../../../base/browser/ui/aria/aria.js';
import type { IAction } from '../../../../../base/common/actions.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { extUriBiasedIgnorePathCase } from '../../../../../base/common/resources.js';
import { type ICodeEditor, type IOverlayWidget, OverlayWidgetPositionPreference } from '../../../../../editor/browser/editorBrowser.js';
import { EditorOption } from '../../../../../editor/common/config/editorOptions.js';
import { localize } from '../../../../../nls.js';
import { WorkbenchToolBar } from '../../../../../platform/actions/browser/toolbar.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IChatEditingService, type IModifiedFileEntry, type IModifiedFileEntryChangeHunk } from '../../common/editing/chatEditingService.js';

/** Owns only the review controls and decorations attached to one existing code editor. */
export class ChatEditingCodeEditorIntegration extends Disposable implements IOverlayWidget {
	private readonly domNode = $('.ash-chat-editing-overlay');
	private readonly labelDomNode = $('.ash-chat-editing-count');
	private readonly countdownDomNode = $('.ash-chat-editing-auto-accept');
	private countingDown = false;
	private readonly toolbar: WorkbenchToolBar;
	private readonly decorations;
	private zones: string[] = [];
	private entry: IModifiedFileEntry | undefined;
	private index = 0;

	constructor(private readonly editor: ICodeEditor, @IChatEditingService private readonly editing: IChatEditingService, @IContextMenuService contextMenus: IContextMenuService, @IContextKeyService contexts: IContextKeyService, @IAccessibleViewService accessibleViews: IAccessibleViewService, @INotificationService private readonly notifications: INotificationService) {
		super();
		this.domNode.append(this.labelDomNode, this.countdownDomNode);
		this.toolbar = this._register(new WorkbenchToolBar(this.domNode, contextMenus, { ariaLabel: localize('chatEditing.toolbar', 'Review Agent changes') }));
		this.decorations = editor.createDecorationsCollection();
		this._register(toDisposable(() => { this.clearZones(); this.decorations.clear(); editor.removeOverlayWidget(this); }));
		const context = this._register(contexts.createScoped(this.domNode));
		context.createKey('chatEditingReviewFocused', true);
		for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
			this._register(AccessibleViewRegistry.register({
				type, priority: 110, name: `chatEditing.${editor.getId()}.${type}`, when: ContextKeyExpr.has('chatEditingReviewFocused'),
				getProvider: () => {
					const focused = this.domNode.ownerDocument.activeElement as HTMLElement;
					if (!this.domNode.contains(focused)) { return undefined; }
					return new AccessibleContentProvider(
						AccessibleViewProviderId.ChatEditing, { type }, () => this.accessibleContent(type),
						() => focused.isConnected ? focused.focus() : this.editor.focus(),
						AccessibilityVerbositySettingId.ChatEditing,
					);
				},
			}));
		}
		this._register(addDisposableListener(this.domNode, 'focusin', () => {
			const hint = accessibleViews.getOpenAriaHint(AccessibilityVerbositySettingId.ChatEditing);
			if (hint) { this.domNode.setAttribute('aria-description', hint); }
		}));
		this._register(addDisposableListener(this.domNode, 'keydown', event => {
			if (event.key === 'Escape') { event.stopPropagation(); editor.focus(); }
		}));
		this._register(editing.onDidChange(() => this.render()));
		this._register(editing.onDidChangeAutoAccept(entry => { if (entry === this.entry) { this.updateCountdown(); } }));
		this._register(editor.onDidChangeModel(() => { this.index = 0; this.render(); }));
		editor.addOverlayWidget(this);
		this.render();
	}

	public getId(): string { return 'chat.edits.review'; }
	public getDomNode(): HTMLElement { return this.domNode; }
	public getPosition(): { preference: OverlayWidgetPositionPreference; } | null { return this.domNode.hidden ? null : { preference: OverlayWidgetPositionPreference.TOP_CENTER }; }

	private accessibleContent(type: AccessibleViewType): string {
		if (type === AccessibleViewType.Help) {
			return localize('chatEditing.help', 'Review Agent changes\nUse Left and Right arrows to move between toolbar actions. Previous and Next reveal each change. Accept or reject the current change or the file. File operations are reviewed as one atomic change set. Shared file changes affect all contributing chats. Accept all and Reject all apply to the chosen chat and require shared changes to be reviewed separately. Cancel automatic acceptance to keep reviewing when a countdown appears. Use Restore Checkpoint to create a new chat and directory at a recorded message boundary; Files follows that directory. Undo Last Request and Redo Last Request move the current chat history and restore its files. Save unsaved files first. Sending a new request clears Redo. Pending reviews are restored after reopening the workspace; their automatic acceptance stays paused. Press Escape to return to the editor. Use the Review Agent changes command to choose a chat and review closed or deleted files.') + '\n' + localize('chatEditing.savePending', 'Rejected changes have not been saved. Retry saving to finish this review.') + ' ' + localize('chatEditing.retrySave', 'Retry saving reviewed changes');
		}
		const chats = this.entry ? this.chatCount(this.entry) : 0;
		const content = this.entry?.getAccessibleContent();
		const review = chats > 1
			? localize('chatEditing.sharedContent', 'Shared changes from {0} chats. Reviewing this file or change set affects all contributing chats.\n{1}', chats, content)
			: content;
		return [review, this.countdownDomNode.textContent].filter(Boolean).join('\n');
	}

	private render(): void {
		const resource = this.editor.getModel()?.uri;
		const entry = resource ? this.editing.entries.find(candidate => candidate.resources.some(uri => extUriBiasedIgnorePathCase.isEqual(resource, uri))) : undefined;
		if (entry !== this.entry) { this.index = 0; }
		this.entry = entry;
		this.domNode.hidden = !entry;
		this.clearZones();
		this.decorations.clear();
		if (!entry) {
			if (this.countingDown) {
				status(localize('chatEditing.autoAccepted', 'Agent changes accepted automatically.'));
				if (this.domNode.contains(this.domNode.ownerDocument.activeElement)) { this.editor.focus(); }
			}
			this.countingDown = false;
			this.countdownDomNode.textContent = '';
			this.toolbar.setActions([]); this.editor.layoutOverlayWidget(this); return;
		}
		this.index = Math.min(this.index, Math.max(0, entry.hunks.length - 1));
		this.labelDomNode.textContent = entry.hasPendingSave ? localize('chatEditing.retrySave', 'Retry saving reviewed changes') : entry.hunks.length > 0 ? localize('chatEditing.counter', '{0} of {1}', this.index + 1, entry.hunks.length) : localize('chatEditing.fileSet', '{0} files', entry.resources.length);
		this.decorations.set(entry.hunks.map(hunk => ({ range: hunk.range, options: { description: 'chat-editing-review', isWholeLine: true, className: 'ash-chat-editing-added', linesDecorationsClassName: 'ash-chat-editing-gutter' } })));
		this.editor.changeViewZones(accessor => {
			for (const hunk of entry.hunks) {
				if (!hunk.originalText) { continue; }
				const deletedDomNode = $('.ash-chat-editing-deleted');
				deletedDomNode.textContent = hunk.originalText.replace(/\n$/u, '');
				deletedDomNode.setAttribute('aria-hidden', 'true');
				const height = hunk.originalText.replace(/\n$/u, '').split('\n').length;
				deletedDomNode.style.lineHeight = `${this.editor.getOption(EditorOption.lineHeight)}px`;
				deletedDomNode.style.fontFamily = this.editor.getOption(EditorOption.fontFamily);
				deletedDomNode.style.fontSize = `${this.editor.getOption(EditorOption.fontSize)}px`;
				this.zones.push(accessor.addZone({ afterLineNumber: Math.max(0, hunk.range.startLineNumber - 1), heightInLines: height, domNode: deletedDomNode }));
			}
		});
		this.updateCountdown();
		this.renderActions(entry);
		this.editor.layoutOverlayWidget(this);
	}

	private renderActions(entry: IModifiedFileEntry): void {
		const actions: IAction[] = [];
		const chats = this.chatCount(entry);
		if (entry.hunks.length > 0) {
			actions.push(this.action('previous', localize('chatEditing.previous', 'Previous change'), Lxicon.chevronUp, () => this.navigate(-1)), this.action('next', localize('chatEditing.next', 'Next change'), Lxicon.chevronDown, () => this.navigate(1)));
			const acceptHunk = chats > 1 ? localize('chatEditing.acceptSharedHunk', 'Accept change from {0} chats', chats) : localize('chatEditing.acceptHunk', 'Accept change');
			const rejectHunk = chats > 1 ? localize('chatEditing.rejectSharedHunk', 'Reject change from {0} chats', chats) : localize('chatEditing.rejectHunk', 'Reject change');
			actions.push(
				this.action('acceptHunk', acceptHunk, Lxicon.check, () => this.decide(entry, true, entry.hunks[this.index])),
				this.action('rejectHunk', rejectHunk, Lxicon.discard, () => this.decide(entry, false, entry.hunks[this.index])),
			);
		}
		const acceptFile = chats > 1 ? localize('chatEditing.acceptShared', 'Accept changes from {0} chats', chats)
			: entry.isFileOperation ? localize('chatEditing.acceptSet', 'Accept change set') : localize('chatEditing.accept', 'Accept file changes');
		const rejectFile = entry.hasPendingSave ? localize('chatEditing.retrySave', 'Retry saving reviewed changes') : chats > 1 ? localize('chatEditing.rejectShared', 'Reject changes from {0} chats', chats)
			: entry.isFileOperation ? localize('chatEditing.rejectSet', 'Reject change set') : localize('chatEditing.reject', 'Reject file changes');
		actions.push(
			this.action('accept', acceptFile, Lxicon.check, () => this.decide(entry, true)),
			this.action('reject', rejectFile, Lxicon.discard, () => this.decide(entry, false)),
		);
		if (this.countingDown) {
			actions.push(this.action('cancelAutoAccept', localize('chatEditing.cancelAutoAccept', 'Cancel automatic acceptance'), Lxicon.close, () => {
				this.editing.cancelAutoAccept(entry);
				status(localize('chatEditing.autoAcceptCancelled', 'Automatic acceptance cancelled. Changes remain available for review.'));
				this.toolbar.focus();
			}));
		}
		this.toolbar.setActions(actions);
	}

	private chatCount(entry: IModifiedFileEntry): number {
		return this.editing.editingSessionsObs.get().filter(session => session.getEntry(entry.modifiedURI) === entry).length;
	}

	private updateCountdown(): void {
		if (!this.entry) { return; }
		const seconds = this.editing.getAutoAcceptCountdown(this.entry);
		this.countdownDomNode.textContent = seconds === undefined ? '' : localize('chatEditing.autoAcceptCountdown', 'Accepting in {0}s', seconds);
		this.countdownDomNode.hidden = seconds === undefined;
		if (this.countingDown !== (seconds !== undefined)) {
			this.countingDown = seconds !== undefined;
			this.renderActions(this.entry);
			if (this.countingDown) { status(localize('chatEditing.autoAcceptStarted', 'Agent changes will be accepted in {0} seconds. Cancel automatic acceptance to keep reviewing.', seconds)); }
		}
		// Ticks update only text, preserving diff zones and the focused toolbar action.
		this.editor.layoutOverlayWidget(this);
	}

	private action(id: string, label: string, icon: IAction['icon'], run: () => unknown): IAction {
		return { id: `chatEditing.${id}`, label, tooltip: label, icon, enabled: !this.entry?.isBusy, run };
	}

	private navigate(delta: number): void {
		const hunks = this.entry?.hunks ?? [];
		if (hunks.length === 0) { return; }
		this.index = (this.index + delta + hunks.length) % hunks.length;
		this.editor.revealRange(hunks[this.index]!.range);
		this.labelDomNode.textContent = localize('chatEditing.counter', '{0} of {1}', this.index + 1, hunks.length);
		status(localize('chatEditing.atLine', 'Change {0} of {1}, line {2}', this.index + 1, hunks.length, hunks[this.index]!.range.startLineNumber));
	}

	private async decide(entry: IModifiedFileEntry, accept: boolean, hunk?: IModifiedFileEntryChangeHunk): Promise<void> {
		try {
			if (accept) { await this.editing.acceptEntry(entry, hunk); }
			else if (!hunk && entry.hasPendingSave) { await this.editing.retrySaveEntry(entry); }
			else { await this.editing.rejectEntry(entry, hunk); }
			status(accept ? localize('chatEditing.accepted', 'Changes accepted.') : localize('chatEditing.rejected', 'Changes rejected.'));
			if (this.entry) { this.toolbar.focus(); } else { this.editor.focus(); }
		} catch (error) { this.notifications.error(localize('chatEditing.failed', 'Could not review changes: {0}', String(error))); }
	}

	private clearZones(): void {
		if (this.zones.length === 0) { return; }
		this.editor.changeViewZones(accessor => { for (const zone of this.zones) { accessor.removeZone(zone); } });
		this.zones = [];
	}
}
