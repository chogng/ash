import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Pane, PaneView } from '../../../../base/browser/ui/splitview/paneview.js';
import { observeElementSize } from '../../../../base/browser/observer.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IContextKeyService, ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { OpenFolderWorkspaceSupportContext, BrowserLocalFolderSupportContext } from '../../../common/contextkeys.js';
import { DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../base/common/event.js';
import type { IAction } from '../../../../base/common/actions.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import { WorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IDebugService, type IDebugSession, type IDataBreakpointOptions } from '../common/debug.js';
import { DEBUG_CONFIGURE_COMMAND_ID } from './debugCommands.js';
import { ViewPane, type IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { VariablesView } from './variablesView.js';
import { WatchExpressionsView } from './watchExpressionsView.js';
import { CallStackView } from './callStackView.js';
import { BreakpointsView } from './breakpointsView.js';

type DebugOperation = "continue" | "pause" | "restart" | "stepOver" | "stepInto" | "stepOut" | "stop" | "stopAll";

/** Composes the Run and Debug sidebar; each inspection pane owns its own content lifetime. */
export class DebugViewPane extends ViewPane {
	private readonly paneView: PaneView;
	private readonly welcome: DebugSection;
	private readonly welcomeButton: Button;
	private readonly welcomeDescription: HTMLElement;
	private readonly controls: HTMLElement;
	private readonly configurationRequest = this._register(new MutableDisposable<DisposableStore>());
	private readonly sessionToolbar: WorkbenchToolBar;
	private readonly sections: readonly ViewPane[];
	private readonly sectionSizes = new Map<Pane, number>();
	private readonly sizingChanges = this._register(new Emitter<void>());
	private mountedSections: readonly Pane[] = [];
	private hasDebugged = false;
	private error: string | undefined;
	constructor(container: HTMLElement, options: IViewPaneOptions,
		@IDebugService private readonly debug: IDebugService,
		@IContextMenuService contextMenus: IContextMenuService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IFileDialogService private readonly fileDialogs: IFileDialogService,
		@IContextKeyService private readonly contexts: IContextKeyService,
		@ICommandService private readonly commands: ICommandService,
		@IInstantiationService instantiationService: IInstantiationService) {
		super(container, options);
		const document = container.ownerDocument;
		this.setHeaderVisible(false);
		this.contentElement.classList.add('ash-debug');
		this.controls = h(document, 'div');
		this.controls.className = 'ash-debug-controls';
		this.sessionsElement = select(document, localize('debug.session', 'Active debug session'));
		this.sessionToolbar = this._register(new WorkbenchToolBar(this.controls, contextMenus, { ariaLabel: localize('debug.controls', 'Debug controls') }));
		this.controls.prepend(this.sessionsElement);
		this.statusElement = h(document, 'div');
		this.statusElement.className = 'ash-debug-status';
		this.statusElement.setAttribute('role', 'status');
		this.statusElement.setAttribute('aria-live', 'polite');
		this.contentElement.append(this.controls, this.statusElement);
		this.paneView = this._register(new PaneView(this.contentElement));
		const dataRequests = this._register(new Emitter<IDataBreakpointOptions>());
		const instructionRequests = this._register(new Emitter<string>());
		const assignments = this._register(new Emitter<void>());
		const reportError = (message: string) => { this.error = message; this.render(); };
		const paneOptions = (id: string, title: string): IViewPaneOptions => ({ id, title, minimumBodySize: 32 });
		const stack = this._register(instantiationService.createInstance(CallStackView, this.paneView.element,
			paneOptions('ash-debug-stack', localize('debug.callStack', 'Call Stack')), (instruction: string) => instructionRequests.fire(instruction), reportError));
		const variables = this._register(instantiationService.createInstance(VariablesView, this.paneView.element,
			paneOptions('ash-debug-variables', localize('debug.variables', 'Variables')), (options: IDataBreakpointOptions) => dataRequests.fire(options), () => assignments.fire(), reportError));
		const watch = this._register(instantiationService.createInstance(WatchExpressionsView, this.paneView.element,
			paneOptions('ash-debug-watch', localize('debug.watch', 'Watch')), assignments.event, reportError));
		const breakpoints: BreakpointsView = this._register(instantiationService.createInstance(BreakpointsView, this.paneView.element,
			paneOptions('ash-debug-breakpoints', localize('debug.breakpoints', 'Breakpoints')), dataRequests.event, instructionRequests.event, this.sizingChanges.event,
			() => this.mountedSections.every(section => section === breakpoints || section.isCollapsed()), reportError));
		this.sections = [variables, watch, stack, breakpoints];
		for (const [section, size] of [[variables, 240], [watch, 80], [stack, 180], [breakpoints, 120]] as const) this.sectionSizes.set(section, size);
		this.welcome = this._register(new DebugSection(this.paneView.element, "ash-debug-welcome", () => localize("debug.run", "Run"), 400));
		this.welcome.list.remove();
		this.welcome.body.classList.add("ash-debug-welcome-content");
		this.welcomeButton = this._register(new Button(this.welcome.body, {
			...defaultButtonStyles,
			label: localize("debug.createLaunch", "Create a launch.json file"),
			presentation: "primary",
			onClick: () => { void this.configure().catch(error => { if (!isCancellationError(error)) { this.error = message(error); this.render(); } }); },
		}));
		this.welcomeDescription = h(document, "p");
		this.welcome.body.append(this.welcomeDescription);

		this.sectionSizes.set(this.welcome, 400);
		this._register(observeElementSize(this.paneView.element, size => { if (size.height > 0 && size.width > 0) this.paneView.layout(size.height, size.width); }));
		for (const section of this.sections) this._register(section.onDidChangeExpansionState(() => this.sizingChanges.fire()));
		this._register(this.welcome.onDidChangeExpansionState(() => this.sizingChanges.fire()));
		this._register(workspace.onDidChangeWorkspace(() => this.render()));
		this._register(addDisposableListener(this.sessionsElement, 'change', () => this.selectSession()));
		this._register(debug.onDidChangeConfigurations(() => this.render()));
		this._register(debug.onDidChangeBreakpoints(() => this.render()));
		this._register(debug.onDidChangeSession(session => { if (session) this.hasDebugged = true; this.error = undefined; this.render(); }));
		this._register(debug.getViewModel().onDidFocusStackFrame(() => { this.error = undefined; this.render(); }));
		this.hasDebugged = debug.session !== undefined;
		this.render();
		void debug.refresh().catch(error => { this.error = message(error); this.render(); });
	}
	private readonly sessionsElement: HTMLSelectElement;
	private readonly statusElement: HTMLDivElement;
	private async configure(): Promise<void> {
		if (this.workspace.getWorkspace().folders.length === 0) {
			await this.fileDialogs.pickFolderAndOpen();
			return;
		}
		const controller = new AbortController();
		const lifetime = new DisposableStore();
		lifetime.add(toDisposable(() => controller.abort()));
		lifetime.add(this.workspace.onDidChangeWorkspace(() => controller.abort()));
		this.configurationRequest.value = lifetime;
		try {
			await this.commands.executeCommand(DEBUG_CONFIGURE_COMMAND_ID, undefined, false, controller.signal);
		} finally {
			if (this.configurationRequest.value === lifetime) this.configurationRequest.clear();
		}
	}

	private control(operation: DebugOperation): void {
		this.error = undefined;
		const session = this.debug.session;
		let action: Promise<unknown>;
		switch (operation) {
			case "restart": action = this.debug.restart(); break;
			case "stop": action = this.debug.stop(); break;
			case "stopAll": action = this.debug.stopAll(); break;
			default: action = session![operation](); break;
		}
		void action.catch(error => {
			if (isCancellationError(error)) return;
			this.error = message(error);
			this.render();
		});
	}

	private debugAction(operation: DebugOperation, label: string, icon: IAction["icon"], enabled = true): IAction {
		return { id: `ash.debug.${operation}`, label, tooltip: label, icon, enabled, run: () => this.control(operation) };
	}

	private selectSession(): void {
		const session = this.debug.sessions.find(candidate => candidate.id === this.sessionsElement.value);
		if (session) this.debug.setActiveSession(session);
	}

	private render(): void {
		if (this.isDisposed) return;
		this.sessionsElement.setAttribute("aria-label", localize("debug.session", "Active debug session"));
		const hasConfigurations = this.debug.configurations.length + this.debug.compounds.length > 0;
		const session = this.debug.session;
		const active = session !== undefined && session.state !== "terminated" && session.state !== "error";
		const stopped = session?.state === "stopped";
		const showInspection = hasConfigurations || active || this.hasDebugged;
		const hasFolder = this.workspace.getWorkspace().folders.length > 0;
		this.controls.hidden = !showInspection;
		this.controls.classList.toggle("empty", !showInspection);
		this.welcomeButton.label = hasFolder ? localize("debug.createLaunch", "Create a launch.json file") : localize("debug.openFolder", "Open Folder");
		this.welcomeButton.enabled = hasFolder || this.contexts.contextMatchesRules(ContextKeyExpr.or(OpenFolderWorkspaceSupportContext.isEqualTo(true), BrowserLocalFolderSupportContext.isEqualTo(true)));
		this.welcomeDescription.textContent = hasFolder
			? localize("debug.welcomeConfigure", "To customize Run and Debug, create a launch.json file and add a debug configuration.")
			: localize("debug.welcomeOpenFolder", "To customize Run and Debug, open a folder and create a launch.json file.");
		let desiredSections: readonly Pane[];
		if (showInspection) {
			desiredSections = this.sections;
		} else if (this.debug.breakpoints.length + this.debug.functionBreakpoints.length + this.debug.dataBreakpoints.length + this.debug.instructionBreakpoints.length > 0) {
			desiredSections = [this.welcome, this.sections[3]!];
		} else {
			desiredSections = [this.welcome];
		}
		for (const section of this.mountedSections) {
			if (!desiredSections.includes(section)) this.paneView.removePane(section);
		}
		for (const [index, section] of desiredSections.entries()) {
			if (!this.mountedSections.includes(section)) this.paneView.addPane(section, this.sectionSizes.get(section)!, index);
		}
		this.mountedSections = desiredSections;
		for (const section of this.sections) section.setVisible(desiredSections.includes(section));
		this.sizingChanges.fire();
		this.sessionToolbar.element.hidden = !active;
		this.sessionToolbar.element.classList.toggle("empty", !active);
		this.sessionToolbar.element.setAttribute("aria-label", localize("debug.controls", "Debug controls"));
		this.sessionToolbar.setActions(active ? [
			stopped ? this.debugAction("continue", localize("debug.continue", "Continue"), Lxicon.start) : this.debugAction("pause", localize("debug.pause", "Pause"), Lxicon.pause, session.state === "running"),
			this.debugAction("stepOver", localize("debug.stepOver", "Step Over"), Lxicon.arrowRight, stopped),
			this.debugAction("stepInto", localize("debug.stepInto", "Step Into"), Lxicon.arrowDown, stopped),
			this.debugAction("stepOut", localize("debug.stepOut", "Step Out"), Lxicon.arrowUp, stopped),
			this.debugAction("restart", localize("debug.restart", "Restart"), Lxicon.refresh, session.state !== "starting"),
			this.debugAction("stop", localize("debug.stop", "Stop"), Lxicon.square),
		] : [], this.debug.sessions.length > 1 ? [this.debugAction("stopAll", localize("debug.stopAll", "Stop All"), Lxicon.square)] : []);
		this.sessionsElement.replaceChildren(...this.debug.sessions.map(candidate => option(this.element.ownerDocument, candidate.id, `${candidate.name} — ${sessionStateLabel(candidate.state)}`)));
		if (session) this.sessionsElement.value = session.id;
		this.sessionsElement.hidden = this.debug.sessions.length < 2;
		this.statusElement.classList.toggle("error", this.error !== undefined);
		let status = "";
		if (session) {
			status = `${session.name}: ${sessionStateLabel(session.state)}${session.reason ? ` (${session.reason})` : ""}`;
		}
		this.statusElement.textContent = this.error ?? status;
		this.statusElement.hidden = !this.statusElement.textContent;
		this.statusElement.classList.toggle("empty", !this.statusElement.textContent);
	}

}
function select(document: Document, label: string): HTMLSelectElement { const element = h(document, "select"); element.setAttribute("aria-label", label); return element; }
function option(document: Document, value: string, label: string): HTMLOptionElement { const element = h(document, "option"); element.value = value; element.textContent = label; return element; }
class DebugSection extends Pane {
	public readonly list: HTMLUListElement;
	public readonly body: HTMLElement;
	public readonly actions: HTMLElement;

	constructor(container: HTMLElement, className: string, public readonly label: () => string, public readonly initialSize: number) {
		super(container, { id: className, title: label(), minimumBodySize: 32 });
		this.body = this.contentElement;
		this.actions = this.headerActionsElement;
		this.element.classList.add("ash-debug-section");
		this.body.classList.add("ash-debug-section-content");
		this.list = h(container.ownerDocument, "ul");
		this.list.className = `ash-debug-list ${className}`;
		this.list.setAttribute("aria-label", label());
		this.body.append(this.list);
		// PaneView mounts only sections needed for the current debug state.
		this.element.remove();
	}
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function sessionStateLabel(state: IDebugSession["state"]): string {
	switch (state) {
		case "starting": return localize("debug.state.starting", "starting");
		case "running": return localize("debug.state.running", "running");
		case "stopped": return localize("debug.state.stopped", "stopped");
		case "terminated": return localize("debug.state.terminated", "terminated");
		case "error": return localize("debug.state.error", "error");
	}
}
