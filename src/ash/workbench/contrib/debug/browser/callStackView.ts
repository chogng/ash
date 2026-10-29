import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { ADD_INSTRUCTION_BREAKPOINT_ID } from './debugCommands.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ViewPane, type IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { getHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegate.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import { WorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IDebugService, type IDebugSession, type IDebugThread, type IDebugStackFrame } from '../common/debug.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { DisassemblyViewInput } from '../common/disassemblyViewInput.js';

/** Displays stopped threads and frames; submits explicit frame selection to DebugService. */
export class CallStackView extends ViewPane {
	private readonly loadingProgress = this._register(new MutableDisposable());
	private readonly threadsElement: HTMLSelectElement;
	private readonly stackElement: HTMLUListElement;
	private readonly instructionToolbar: WorkbenchToolBar;
	private readonly rowControls = this._register(new DisposableStore());
	private threads: readonly IDebugThread[] = [];
	private frames: readonly IDebugStackFrame[] = [];
	private refreshGeneration = 0;
	constructor(container: HTMLElement, options: IViewPaneOptions,
		@IDebugService private readonly debug: IDebugService,
		@IEditorService private readonly editor: IEditorService,
		@IContextMenuService contextMenus: IContextMenuService,
		@ICommandService private readonly commands: ICommandService,
		@INotificationService private readonly notifications: INotificationService) {
		super(container, { minimumBodySize: 32, ...options });
		this.element.classList.add('ash-debug-section');
		this.contentElement.classList.add('ash-debug-section-content');
		this.threadsElement = select(container.ownerDocument, localize('debug.thread', 'Debug thread'));
		this.threadsElement.classList.add('ash-debug-thread-select');
		this.stackElement = h(container.ownerDocument, 'ul');
		this.stackElement.className = 'ash-debug-list ash-debug-stack';
		this.stackElement.setAttribute('aria-label', localize('debug.callStack', 'Call Stack'));
		this.contentElement.append(this.threadsElement, this.stackElement);
		this.instructionToolbar = this._register(new WorkbenchToolBar(this.headerActionsElement, contextMenus, { ariaLabel: localize('debug.callStack', 'Call Stack') }));
		this._register(addDisposableListener(this.threadsElement, 'change', () => { void this.selectThread(); }));
		this._register(addDisposableListener(this.stackElement, 'click', event => this.activateFrame(event)));
		this._register(debug.onDidChangeSession(() => { void this.refreshStoppedState(); }));
		this._register(debug.getViewModel().onDidFocusThread(() => this.render()));
		this._register(debug.getViewModel().onDidFocusStackFrame(() => this.render()));
		void this.refreshStoppedState();
	}
	private async selectThread(): Promise<void> {
		const session = this.debug.session;
		const threadId = Number(this.threadsElement.value);
		if (!session || !this.threadsElement.value || !Number.isSafeInteger(threadId)) return;
		session.selectThread(threadId);
		await this.refreshStoppedState();
	}

	private async refreshStoppedState(): Promise<void> {
		this.loadingProgress.clear();
		const session = this.debug.session;
		const generation = ++this.refreshGeneration;
		this.threads = []; this.frames = [];
		this.render();
		if (!session || session.state !== 'stopped') return;
		try {
			const loading = session.inspectStack(session.threadId);
			const progress = this.getProgressIndicator().show(true, 150);
			const handle = toDisposable(() => progress.done());
			this.loadingProgress.value = handle;
			const finish = (): void => { if (this.loadingProgress.value === handle) this.loadingProgress.clear(); };
			void loading.then(finish, finish);
			const inspection = await loading;
			if (!this.isCurrentInspection(session, generation)) return;
			if (inspection.threadId === undefined) throw new Error(localize('debug.noThreads', 'The Debug Adapter did not report any stopped threads'));
			session.selectThread(inspection.threadId);
			this.threads = inspection.threads;
			this.frames = inspection.frames;
		} catch (error) { if (this.isCurrentInspection(session, generation)) this.notifications.error(message(error)); }
		if (this.isCurrentInspection(session, generation)) this.render();
	}
	private isCurrentInspection(session: IDebugSession, generation: number): boolean {
		return !this.isDisposed && generation === this.refreshGeneration && this.debug.session === session && session.state === 'stopped';
	}

	private activateFrame(event: Event): void {
		const index = indexFromEvent(event, '.ash-debug-frame', 'frameIndex', this.element.ownerDocument);
		const frame = index === undefined ? undefined : this.frames[index];
		const session = this.debug.session;
		if (!frame || !session || session.state !== 'stopped') return;
		this.loadingProgress.clear();
		const generation = ++this.refreshGeneration;
		void this.debug.focusStackFrame(frame, this.threads.find(thread => thread.id === session.threadId)).catch(error => {
			if (this.isCurrentInspection(session, generation)) this.notifications.error(message(error));
		});
		this.render();
	}
	private render(): void {
		const session = this.debug.session;
		const stopped = session?.state === 'stopped';
		this.threadsElement.replaceChildren(...this.threads.map(thread => option(this.element.ownerDocument, String(thread.id), thread.name)));
		const focusedThread = this.debug.getViewModel().focusedThread;
		if (focusedThread) this.threadsElement.value = String(focusedThread.id);
		this.threadsElement.hidden = this.threads.length < 2;
		this.rowControls.clear();
		this.stackElement.replaceChildren(...this.frames.map((frame, index) => itemButton(this.rowControls, this.element.ownerDocument, `${frame.name}  ${frame.source?.name ?? frame.source?.path ?? ''}${frame.lineNumber > 0 ? `:${frame.lineNumber}` : ''}`, 'ash-debug-frame', 'frameIndex', index, frame.id === this.debug.getViewModel().focusedStackFrame?.id)));
		const instructionLabel = localize('debug.addInstructionBreakpoint', 'Add Instruction Breakpoint');
		this.instructionToolbar.setActions([{
			id: 'debug.addInstructionBreakpoint',
			label: instructionLabel,
			tooltip: instructionLabel,
			icon: Lxicon.add,
			enabled: Boolean(stopped && session.capabilities.supportsInstructionBreakpoints),
			run: () => this.commands.executeCommand(ADD_INSTRUCTION_BREAKPOINT_ID, this.debug.getViewModel().focusedStackFrame?.instructionPointerReference ?? ''),
		}, {
			id: 'debug.action.openDisassemblyView', label: localize('debug.openDisassembly', 'Open Disassembly View'), tooltip: localize('debug.openDisassembly', 'Open Disassembly View'), icon: Lxicon.code,
			enabled: Boolean(stopped && session.capabilities.supportsDisassembleRequest),
			run: () => this.editor.openEditor(new DisassemblyViewInput(), { pinned: true }),
		}]);
	}
}
function select(document: Document, label: string): HTMLSelectElement { const element = h(document, 'select'); element.setAttribute('aria-label', label); return element; }
function option(document: Document, value: string, label: string): HTMLOptionElement { const element = h(document, 'option'); element.value = value; element.textContent = label; return element; }
function itemButton(owner: DisposableStore, document: Document, label: string, className: string, dataName: string, index: number, selected = false): HTMLLIElement {
	const item = h(document, 'li');
	const action = h(document, 'button');
	action.type = 'button';
	action.className = className;
	action.classList.toggle('selected', selected);
	action.textContent = label;
	action.dataset[dataName] = String(index);
	owner.add(getHoverDelegate().setupHover({ target: action, content: label }));
	item.append(action);
	return item;
}
function indexFromEvent(event: Event, selector: string, dataName: string, document: Document): number | undefined { const target = event.target instanceof document.defaultView!.Element ? event.target.closest<HTMLElement>(selector) : null; const raw = target?.dataset[dataName]; if (raw === undefined) return undefined; const index = Number(raw); return Number.isSafeInteger(index) && index >= 0 ? index : undefined; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
