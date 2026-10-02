import { Dimension, h, type IDimension } from '../../../../base/browser/dom.js';
import './media/sessionChangesEditor.css';
import { Disposable, MutableDisposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IChatService } from '../../../../workbench/services/chat/common/chatService.js';
import { EditorPanes } from '../../../../workbench/browser/editor.js';
import { EditorPaneVisibility, type EditorPaneCreationOptions, type IEditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import type { EditorInput } from '../../../../workbench/services/editor/common/editorService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { createTurnMultiDiffEditorInput } from '../../../browser/turnMultiDiffSource.js';
import type { MultiDiffEditorInput } from '../../../../workbench/contrib/multiDiffEditor/browser/multiDiffEditorInput.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IAccessibleViewService, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';

/** Resolves the selected conversation's changes only while its editor content is visible. */
export class SessionChangesEditor extends Disposable implements IEditorPane {
	public readonly id = 'ash.sessions.changesEditor';
	private readonly comparison = this._register(new MutableDisposable<IEditorPane>());
	private domNode!: HTMLDivElement;
	private messageDomNode!: HTMLParagraphElement;
	private input: EditorInput | undefined;
	private comparisonInput: MultiDiffEditorInput | undefined;
	private dimension: IDimension = Dimension.Zero;
	private visible = false;
	private revision = 0;
	private readonly pending = this._register(new MutableDisposable<IDisposable>());

	constructor(
		private readonly options: EditorPaneCreationOptions,
		@IChatService private readonly chat: IChatService,
		@ISessionsManagementService private readonly sessions: ISessionsManagementService,
		@IContextKeyService private readonly contextKeys: IContextKeyService,
		@IAccessibleViewService private readonly accessibleViews: IAccessibleViewService,
		@IConfigurationService private readonly configuration: IConfigurationService,
	) {
		super();
		this._register(chat.onDidUpdateTurnChanges(event => {
			if (this.input?.resource.path === `/${event.sessionId}` && new URLSearchParams(this.input.resource.query).get('thread') === event.threadId) {
				void this.refresh();
			}
		}));
		this._register(chat.onDidBecomeReady(() => { void this.refresh(); }));
	}

	public create(parent: HTMLElement): void {
		this.domNode = h(parent.ownerDocument, 'div', { className: 'ash-sessions-changes-editor' });
		this.messageDomNode = h(parent.ownerDocument, 'p', { className: 'ash-sessions-editor-message' });
		this.messageDomNode.setAttribute('role', 'status');
		this.domNode.tabIndex = 0;
		this.domNode.setAttribute('aria-label', localize('sessions.changes.title', 'Changes'));
		const context = this._register(this.contextKeys.createScoped(this.domNode));
		context.createKey('sessionsChangesEditorFocused', true);
		const updateHint = (): void => {
			const hint = this.accessibleViews.getOpenAriaHint(AccessibilityVerbositySettingId.SessionsChanges);
			if (hint) {
				this.domNode.setAttribute('aria-description', hint);
			} else {
				this.domNode.removeAttribute('aria-description');
			}
		};
		this._register(this.configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(AccessibilityVerbositySettingId.SessionsChanges)) {
				updateHint();
			}
		}));
		updateHint();
		this.domNode.append(this.messageDomNode);
		parent.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
	}

	public async setInput(input: EditorInput, _signal: AbortSignal): Promise<void> {
		this.input = input;
		await this.refresh();
	}

	public clearInput(): void {
		this.input = undefined;
		this.comparisonInput = undefined;
		this.revision++;
		this.pending.clear();
		this.comparison.clear();
	}

	public getAccessibleContent(): string {
		if (!this.comparisonInput) {
			return this.messageDomNode.textContent ?? '';
		}
		return this.comparisonInput.items.map(item => localize('sessions.changes.editorComparison', '{0}\nBefore:\n{1}\nAfter:\n{2}', item.label ?? item.modified.resource.path, item.original.initialText ?? '', item.modified.initialText ?? '')).join('\n\n');
	}

	public setVisible(visibility: EditorPaneVisibility): void {
		const visible = visibility === EditorPaneVisibility.Visible;
		if (this.visible === visible) {
			return;
		}
		this.visible = visible;
		if (this.visible) {
			void this.refresh();
		} else {
			this.revision++;
			this.pending.clear();
			this.comparison.clear();
			this.comparisonInput = undefined;
		}
	}

	public layout(dimension: IDimension): void {
		this.dimension = dimension;
		this.comparison.value?.layout(dimension);
	}
	public focus(): void {
		if (this.comparison.value) {
			this.comparison.value.focus();
		} else {
			this.domNode.focus();
		}
	}

	private async refresh(): Promise<void> {
		const input = this.input;
		if (!input || !this.visible || this.isDisposed) {
			return;
		}
		const revision = ++this.revision;
		this.pending.clear();
		this.comparison.clear();
		this.comparisonInput = undefined;
		this.messageDomNode.hidden = false;
		const threadId = new URLSearchParams(input.resource.query).get('thread');
		if (!threadId) {
			this.messageDomNode.textContent = localize('sessions.changes.draft', 'Changes appear after the agent edits files.');
			return;
		}
		const session = this.sessions.sessions.find(session => input.resource.path === `/${session.sessionId}`);
		if (!session) {
			return;
		}
		this.messageDomNode.textContent = localize('sessions.changes.loading', 'Loading changes…');
		const controller = new AbortController();
		this.pending.value = toDisposable(() => controller.abort());
		try {
			const changes = await this.chat.listTurnChanges(session.sessionId, threadId);
			if (this.isDisposed || revision !== this.revision) {
				return;
			}
			if (!changes.some(change => change.captureState !== 'discarded' && change.statistics.files > 0)) {
				this.messageDomNode.textContent = localize('sessions.changes.empty', 'No changes in this conversation.');
				return;
			}
			const comparison = await createTurnMultiDiffEditorInput(this.chat, { session, threadId }, 'throughCurrentTurn');
			if (this.isDisposed || revision !== this.revision) {
				return;
			}
			const pane = EditorPanes.getEditorPane(comparison)!.create(this.options);
			this.comparisonInput = comparison;
			this.comparison.value = pane;
			pane.create(this.domNode);
			await pane.setInput(comparison, controller.signal);
			if (this.isDisposed || revision !== this.revision) {
				return;
			}
			this.messageDomNode.hidden = true;
			pane.layout(this.dimension);
			pane.setVisible(EditorPaneVisibility.Visible);
		} catch (error) {
			if (!this.isDisposed && revision === this.revision) {
				this.messageDomNode.textContent = localize('sessions.changes.error', 'Could not load changes: {0}', String(error));
			}
		}
	}
}
