import { ViewPane, type IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { getHoverDelegate } from '../../../../base/browser/ui/hover/hoverDelegate.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import { WorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IDebugService, type IDebugSession, type IDebugThread, type IDebugStackFrame, DISASSEMBLY_VIEW_ID } from '../common/debug.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { Position } from '../../../../editor/common/core/position.js';
import { Range } from '../../../../editor/common/core/range.js';
import { getUriFromSource } from '../common/debugSource.js';
import { DisassemblyViewInput } from '../common/disassemblyViewInput.js';

/** Call Stack owns stopped-thread discovery, frame selection and source navigation. */
export class CallStackView extends ViewPane {
	private readonly threadsElement: HTMLSelectElement;
	private readonly stackElement: HTMLUListElement;
	private readonly instructionToolbar: WorkbenchToolBar;
	private readonly rowControls = this._register(new DisposableStore());
	private threads: readonly IDebugThread[] = [];
	private frames: readonly IDebugStackFrame[] = [];
	private refreshGeneration = 0;
	constructor(container: HTMLElement, options: IViewPaneOptions,
		private readonly requestInstructionBreakpoint: (instruction: string) => void,
		private readonly reportError: (message: string) => void,
		@IDebugService private readonly debug: IDebugService,
		@IEditorService private readonly editor: IEditorService,
		@IContextMenuService contextMenus: IContextMenuService,
		@IUriIdentityService private readonly uriIdentity: IUriIdentityService,
		@ILogService private readonly logService: ILogService,
		@ITextModelService private readonly textModels: ITextModelService) {
		super(container, options);
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
		this._register(debug.getViewModel().onDidFocusStackFrame(() => this.render()));
		this.setVisible(true);
		this.element.remove();
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
		const session = this.debug.session;
		const generation = ++this.refreshGeneration;
		this.threads = []; this.frames = [];
		this.debug.focusStackFrame(undefined);
		this.render();
		if (!session || session.state !== 'stopped') return;
		try {
			const inspection = await session.inspectStack(session.threadId);
			if (!this.isCurrentInspection(session, generation)) return;
			if (inspection.threadId === undefined) throw new Error(localize('debug.noThreads', 'The Debug Adapter did not report any stopped threads'));
			session.selectThread(inspection.threadId);
			this.threads = inspection.threads;
			this.frames = inspection.frames;
			const frame = this.frames[0];
			this.debug.focusStackFrame(frame, this.threads.find(thread => thread.id === session.threadId));
			if (frame && frame.lineNumber > 0 && frame.columnNumber > 0 && this.editor.activeEditor?.editorId !== DISASSEMBLY_VIEW_ID) await this.openFrameSource(session, frame, generation);
		} catch (error) { if (this.isCurrentInspection(session, generation)) this.reportError(message(error)); }
		if (this.isCurrentInspection(session, generation)) this.render();
	}
	private isCurrentInspection(session: IDebugSession, generation: number): boolean {
		return !this.isDisposed && generation === this.refreshGeneration && this.debug.session === session && session.state === "stopped";
	}

	private activateFrame(event: Event): void {
		const index = indexFromEvent(event, '.ash-debug-frame', 'frameIndex', this.element.ownerDocument);
		const frame = index === undefined ? undefined : this.frames[index];
		const session = this.debug.session;
		if (!frame || !session || session.state !== 'stopped') return;
		const generation = ++this.refreshGeneration;
		this.debug.focusStackFrame(frame, this.threads.find(thread => thread.id === session.threadId));
		this.render();
		void this.openFrameSource(session, frame, generation).catch(error => { if (this.isCurrentInspection(session, generation)) this.reportError(message(error)); });
	}
	private async openFrameSource(session: IDebugSession, frame: IDebugStackFrame, generation: number): Promise<void> {
		if (!this.isCurrentInspection(session, generation)) return;
		const selection = frame.lineNumber > 0 && frame.columnNumber > 0 ? Range.fromPositions(new Position(frame.lineNumber, frame.columnNumber)) : undefined;
		if (frame.source?.sourceReference && frame.source.sourceReference > 0) {
			const resource = getUriFromSource(frame.source, frame.source.path, session.id, this.uriIdentity, this.logService);
			using reference = await this.textModels.createModelReference(resource);
			if (!this.isCurrentInspection(session, generation)) return;
			await this.editor.openEditor({ resource, label: frame.source.name, readOnly: true }, { selection });
		} else if (frame.source?.resource) {
			await this.editor.openEditor({ resource: frame.source.resource, label: frame.source.name }, { selection });
		}
	}

	private render(): void {
		const session = this.debug.session;
		const stopped = session?.state === 'stopped';
		this.threadsElement.replaceChildren(...this.threads.map(thread => option(this.element.ownerDocument, String(thread.id), thread.name)));
		const focusedThread = this.debug.getViewModel().focusedThread;
		if (focusedThread) this.threadsElement.value = String(focusedThread.id);
		this.threadsElement.hidden = this.threads.length < 2;
		this.rowControls.clear();
		this.stackElement.replaceChildren(...this.frames.map((frame, index) => itemButton(this.rowControls, this.element.ownerDocument, `${frame.name}  ${frame.source?.name ?? frame.source?.path ?? ""}${frame.lineNumber > 0 ? `:${frame.lineNumber}` : ""}`, "ash-debug-frame", "frameIndex", index, frame.id === this.debug.getViewModel().focusedStackFrame?.id)));
		const instructionLabel = localize("debug.addInstructionBreakpoint", "Add Instruction Breakpoint");
		this.instructionToolbar.setActions([{
			id: "debug.addInstructionBreakpoint",
			label: instructionLabel,
			tooltip: instructionLabel,
			icon: Lxicon.add,
			enabled: Boolean(stopped && session.capabilities.supportsInstructionBreakpoints),
			run: () => this.requestInstructionBreakpoint(this.debug.getViewModel().focusedStackFrame?.instructionPointerReference ?? ""),
		}, {
			id: 'debug.action.openDisassemblyView', label: localize('debug.openDisassembly', 'Open Disassembly View'), tooltip: localize('debug.openDisassembly', 'Open Disassembly View'), icon: Lxicon.code,
			enabled: Boolean(stopped && session.capabilities.supportsDisassembleRequest),
			run: () => this.editor.openEditor(new DisassemblyViewInput(), { pinned: true }),
		}]);
	}
}
function select(document: Document, label: string): HTMLSelectElement { const element = h(document, "select"); element.setAttribute("aria-label", label); return element; }
function option(document: Document, value: string, label: string): HTMLOptionElement { const element = h(document, "option"); element.value = value; element.textContent = label; return element; }
function itemButton(owner: DisposableStore, document: Document, label: string, className: string, dataName: string, index: number, selected = false): HTMLLIElement {
	const item = h(document, "li");
	const action = h(document, "button");
	action.type = "button";
	action.className = className;
	action.classList.toggle("selected", selected);
	action.textContent = label;
	action.dataset[dataName] = String(index);
	owner.add(getHoverDelegate().setupHover({ target: action, content: label }));
	item.append(action);
	return item;
}
function indexFromEvent(event: Event, selector: string, dataName: string, document: Document): number | undefined { const target = event.target instanceof document.defaultView!.Element ? event.target.closest<HTMLElement>(selector) : null; const raw = target?.dataset[dataName]; if (raw === undefined) return undefined; const index = Number(raw); return Number.isSafeInteger(index) && index >= 0 ? index : undefined; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
