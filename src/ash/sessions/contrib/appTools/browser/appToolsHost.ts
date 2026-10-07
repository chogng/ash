import './media/appToolsHost.css';
import { CancellationError } from '../../../../base/common/errors.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Range } from '../../../../editor/common/core/range.js';
import type { URI } from '../../../../base/common/uri.js';
import type { IAppToolsHost } from '../../../services/appTools/browser/appTools.js';
import { IAccessibilityService } from '../../../../platform/accessibility/common/accessibility.js';
import { ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { IViewsService } from '../../../../workbench/services/views/common/viewsService.js';
import { TERMINAL_VIEW_ID } from '../../../../workbench/contrib/terminal/common/terminal.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import type { IUpdateService, UpdateCheckResult } from '../../../../platform/update/common/updateService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { createDiffEditorInput } from '../../../../workbench/common/editor/diffEditorInput.js';
import { IChatSessionNavigationService } from '../../../../workbench/services/chat/common/chatSessionNavigationService.js';
import { ISessionGroupsService, type SessionGroup } from '../../../services/sessions/browser/sessionGroupsService.js';

/** Window-owned execution; tool definitions and durable business operations belong to Rust. */
export class AppToolsHost extends Disposable implements IAppToolsHost {
	private readonly celebration = this._register(new MutableDisposable());
	constructor(private readonly ownerDocument: Document, private readonly updates: Pick<IUpdateService, 'checkForUpdates'> | undefined,
		@IEditorService private readonly editors: IEditorService,
		@IOpenerService private readonly opener: IOpenerService,
		@ITerminalService private readonly terminals: ITerminalService,
		@IViewsService private readonly views: IViewsService,
		@IChatSessionNavigationService private readonly navigation: IChatSessionNavigationService,
		@ISessionGroupsService private readonly groups: ISessionGroupsService,
		@IAccessibilityService private readonly accessibility: IAccessibilityService,
	) {
		super();
		this._register(accessibility.onDidChangeReducedMotion(() => { if (accessibility.isMotionReduced()) this.celebration.clear(); }));
	}
	public async openFile(resource: URI, line?: number): Promise<void> {
		await this.editors.openEditor({ resource }, { pinned: true, ignoreError: true, ...(line ? { selection: new Range(line, 1, line, 1) } : {}) });
	}
	public async openReview(original: URI, modified: URI): Promise<void> {
		await this.editors.openEditor(createDiffEditorInput({ resource: original }, { resource: modified }), { pinned: true, ignoreError: true });
	}
	public openBrowser(resource: URI): Promise<boolean> {
		return this.opener.open(resource, { openExternal: true, allowContributedOpeners: 'ash.browser.open', allowCommands: false });
	}
	public async openTerminal(signal: AbortSignal): Promise<string> {
		const terminal = await this.terminals.createTerminal({ profile: { type: 'default' }, dimensions: { cols: 80, rows: 24 } });
		// A cancelled request must release a process that finished creating after cancellation.
		if (signal.aborted || this.isDisposed) {
			await this.terminals.closeTerminal(terminal);
			throw new CancellationError();
		}
		this.terminals.setActiveInstance(terminal);
		await this.views.openView(TERMINAL_VIEW_ID, true);
		return terminal.id;
	}
	public async navigate(sessionId: string, threadId: string): Promise<void> {
		await this.navigation.openConversation(sessionId, threadId);
	}
	public listSections(): readonly SessionGroup[] {
		return this.groups.groups;
	}
	public createSection(name: string, signal: AbortSignal): Promise<SessionGroup> {
		return this.groups.create(name, signal);
	}
	public renameSection(sectionId: string, name: string, signal: AbortSignal): Promise<void> {
		return this.groups.rename(sectionId, name, signal);
	}
	public deleteSection(sectionId: string, signal: AbortSignal): Promise<void> {
		return this.groups.delete(sectionId, signal);
	}
	public moveSession(sessionId: string, sectionId: string | null, signal: AbortSignal): Promise<void> {
		return this.groups.move(sessionId, sectionId, signal);
	}
	public reorderSection(sectionId: string, sessionIds: readonly string[], signal: AbortSignal): Promise<void> {
		return this.groups.reorder(sectionId, sessionIds, signal);
	}
	public async checkUpdate(): Promise<UpdateCheckResult> {
		if (!this.updates) throw new Error('Desktop updates are unavailable in this window');
		return this.updates.checkForUpdates();
	}
	public clearTransientState(): void {
		this.celebration.clear();
	}
	public fireConfetti(): boolean {
		this.celebration.clear();
		if (this.accessibility.isMotionReduced()) return false;
		const overlay = this.ownerDocument.createElement('div');
		overlay.setAttribute('aria-hidden', 'true');
		overlay.className = 'ash-app-confetti';
		const animations: Animation[] = [];
		for (let index = 0; index < 24; index++) {
			const particle = this.ownerDocument.createElement('span');
			particle.textContent = ['🎉', '✨', '🎊'][index % 3];
			particle.className = 'ash-app-confetti-particle';
			particle.style.left = `${(index + 0.5) / 24 * 100}%`;
			overlay.append(particle);
			animations.push(particle.animate([{ transform: 'translateY(-32px) rotate(0deg)', opacity: 1 }, { transform: `translateY(${this.ownerDocument.documentElement.clientHeight}px) rotate(${index % 2 ? 360 : -360}deg)`, opacity: 0 }], { duration: 1500, delay: index % 4 * 60, fill: 'both' }));
		}
		this.ownerDocument.body.append(overlay);
		const timer = setTimeout(() => this.celebration.clear(), 1800);
		this.celebration.value = toDisposable(() => { clearTimeout(timer); animations.forEach(animation => animation.cancel()); overlay.remove(); });
		return true;
	}
}
