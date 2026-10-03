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
	private readonly toolbar: WorkbenchToolBar;
	private readonly decorations;
	private zones: string[] = [];
	private entry: IModifiedFileEntry | undefined;
	private index = 0;

	constructor(private readonly editor: ICodeEditor, @IChatEditingService private readonly editing: IChatEditingService, @IContextMenuService contextMenus: IContextMenuService, @IContextKeyService contexts: IContextKeyService, @IAccessibleViewService accessibleViews: IAccessibleViewService, @INotificationService private readonly notifications: INotificationService) {
		super();
		this.domNode.append(this.labelDomNode);
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
					return new AccessibleContentProvider(AccessibleViewProviderId.ChatEditing, { type }, () => type === AccessibleViewType.Help ? localize('chatEditing.help', 'Review Agent changes\nUse Left and Right arrows to move between toolbar actions. Previous and Next reveal each change. Accept or reject the current change or the file. File operations are reviewed as one atomic change set. Press Escape to return to the editor. Use the Review Agent changes command to review closed or deleted files.') : this.entry?.getAccessibleContent() ?? '', () => focused.isConnected ? focused.focus() : this.editor.focus(), AccessibilityVerbositySettingId.ChatEditing);
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
		this._register(editor.onDidChangeModel(() => { this.index = 0; this.render(); }));
		editor.addOverlayWidget(this);
		this.render();
	}

	public getId(): string { return 'chat.edits.review'; }
	public getDomNode(): HTMLElement { return this.domNode; }
	public getPosition(): { preference: OverlayWidgetPositionPreference } | null { return this.domNode.hidden ? null : { preference: OverlayWidgetPositionPreference.TOP_CENTER }; }

	private render(): void {
		const resource = this.editor.getModel()?.uri;
		const entry = resource ? this.editing.entries.find(candidate => candidate.resources.some(uri => extUriBiasedIgnorePathCase.isEqual(resource, uri))) : undefined;
		if (entry !== this.entry) { this.index = 0; }
		this.entry = entry;
		this.domNode.hidden = !entry;
		this.clearZones();
		this.decorations.clear();
		if (!entry) { this.toolbar.setActions([]); this.editor.layoutOverlayWidget(this); return; }
		this.index = Math.min(this.index, Math.max(0, entry.hunks.length - 1));
		this.labelDomNode.textContent = entry.hunks.length > 0 ? localize('chatEditing.counter', '{0} of {1}', this.index + 1, entry.hunks.length) : localize('chatEditing.fileSet', '{0} files', entry.resources.length);
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
		const actions: IAction[] = [];
		if (entry.hunks.length > 0) {
			actions.push(this.action('previous', localize('chatEditing.previous', 'Previous change'), Lxicon.chevronUp, () => this.navigate(-1)), this.action('next', localize('chatEditing.next', 'Next change'), Lxicon.chevronDown, () => this.navigate(1)));
			actions.push(this.action('acceptHunk', localize('chatEditing.acceptHunk', 'Accept change'), Lxicon.check, () => this.decide(entry, true, entry.hunks[this.index])), this.action('rejectHunk', localize('chatEditing.rejectHunk', 'Reject change'), Lxicon.discard, () => this.decide(entry, false, entry.hunks[this.index])));
		}
		actions.push(this.action('accept', entry.isFileOperation ? localize('chatEditing.acceptSet', 'Accept change set') : localize('chatEditing.accept', 'Accept file changes'), Lxicon.check, () => this.decide(entry, true)), this.action('reject', entry.isFileOperation ? localize('chatEditing.rejectSet', 'Reject change set') : localize('chatEditing.reject', 'Reject file changes'), Lxicon.discard, () => this.decide(entry, false)));
		this.toolbar.setActions(actions);
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
			if (accept) { await this.editing.acceptEntry(entry, hunk); } else { await this.editing.rejectEntry(entry, hunk); }
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
