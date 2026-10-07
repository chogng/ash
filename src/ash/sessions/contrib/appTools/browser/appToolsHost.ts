import './media/appToolsHost.css';
import { CancellationError } from '../../../../base/common/errors.js';
import { throwIfCancelled } from '../../../../base/common/cancellation.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Range } from '../../../../editor/common/core/range.js';
import { URI } from '../../../../base/common/uri.js';
import { AppServerProtocolClient } from '../../../../platform/app-server/browser/appServerProtocolClient.js';
import { APP_SERVER_SERVER_REQUESTS, type AppHostOperation, type AppHostResult } from '../../../../platform/app-server/common/generated/index.js';
import { IAccessibilityService } from '../../../../platform/accessibility/common/accessibility.js';
import { ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { IViewsService } from '../../../../workbench/services/views/common/viewsService.js';
import { TERMINAL_VIEW_ID } from '../../../../workbench/contrib/terminal/common/terminal.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import type { IUpdateService } from '../../../../platform/update/common/updateService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { createDiffEditorInput } from '../../../../workbench/common/editor/diffEditorInput.js';
import { IChatSessionNavigationService } from '../../../../workbench/services/chat/common/chatSessionNavigationService.js';
import { ISessionGroupsService } from '../../../services/sessions/browser/sessionGroupsService.js';

/** UI execution adapter. Tool definitions and durable business operations belong to Rust. */
export class AppToolsHost extends Disposable {
	private readonly celebration = this._register(new MutableDisposable());
	constructor(client: AppServerProtocolClient, private readonly ownerDocument: Document, private readonly updates: Pick<IUpdateService, 'checkForUpdates'> | undefined,
		@IEditorService private readonly editors: IEditorService,
		@IOpenerService private readonly opener: IOpenerService,
		@ITerminalService private readonly terminals: ITerminalService,
		@IViewsService private readonly views: IViewsService,
		@IChatSessionNavigationService private readonly navigation: IChatSessionNavigationService,
		@ISessionGroupsService private readonly groups: ISessionGroupsService,
		@IAccessibilityService private readonly accessibility: IAccessibilityService,
	) {
		super();
		this._register(client.registerRequestHandler(APP_SERVER_SERVER_REQUESTS['app/request'], async (params, context) => {
			throwIfCancelled(context.signal);
			const result = await this.execute(params.operation, context.signal);
			throwIfCancelled(context.signal);
			return { json: JSON.stringify(result) } satisfies AppHostResult;
		}));
		this._register(accessibility.onDidChangeReducedMotion(() => { if (accessibility.isMotionReduced()) this.celebration.clear(); }));
		this._register(client.onStateChange(state => { if (state !== 'ready') this.celebration.clear(); }));
	}
	private async execute(operation: AppHostOperation, signal: AbortSignal): Promise<unknown> {
		switch (operation.type) {
			case 'openFile': {
				await this.editors.openEditor({ resource: URI.file(operation.path) }, { pinned: true, ignoreError: true, ...(operation.line ? { selection: new Range(operation.line, 1, operation.line, 1) } : {}) });
				return { opened: true, path: operation.path };
			}
			case 'openReview': {
				await this.editors.openEditor(createDiffEditorInput({ resource: URI.file(operation.original) }, { resource: URI.file(operation.modified) }), { pinned: true, ignoreError: true });
				return { opened: true };
			}
			case 'openBrowser': return { opened: await this.opener.open(URI.parse(operation.url), { openExternal: true, allowContributedOpeners: 'ash.browser.open', allowCommands: false }) };
			case 'openTerminal': {
				const terminal = await this.terminals.createTerminal({ profile: { type: 'default' }, dimensions: { cols: 80, rows: 24 } });
				// A cancelled request must release a process that finished creating after cancellation.
				if (signal.aborted || this.isDisposed) {
					await this.terminals.closeTerminal(terminal);
					throw new CancellationError();
				}
				this.terminals.setActiveInstance(terminal);
				await this.views.openView(TERMINAL_VIEW_ID, true);
				return { opened: true, terminalId: terminal.id };
			}
			case 'navigate': await this.navigation.openConversation(operation.sessionId, operation.threadId); return { opened: true };
			case 'listSections': return { sections: this.groups.groups };
			case 'createSection': return this.groups.create(operation.name, signal);
			case 'renameSection': await this.groups.rename(operation.sectionId, operation.name, signal); return { sections: this.groups.groups };
			case 'deleteSection': await this.groups.delete(operation.sectionId, signal); return { sections: this.groups.groups };
			case 'moveSession': await this.groups.move(operation.sessionId, operation.sectionId, signal); return { sections: this.groups.groups };
			case 'reorderSection': await this.groups.reorder(operation.sectionId, operation.sessionIds, signal); return { sections: this.groups.groups };
			case 'checkUpdate': {
				if (!this.updates) throw new Error('Desktop updates are unavailable in this window');
				return this.updates.checkForUpdates();
			}
			case 'confetti': return this.fireConfetti();
		}
	}
	private fireConfetti(): { fired: boolean; } {
		this.celebration.clear();
		if (this.accessibility.isMotionReduced()) return { fired: false };
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
		return { fired: true };
	}
}
