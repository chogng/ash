import { addDisposableListener, h } from "../../../../base/browser/dom.js";
import { ActionBar } from "../../../../base/browser/ui/actionbar/actionbar.js";
import type { IAction } from "../../../../base/common/actions.js";
import { lxiconsLibrary } from "../../../../base/common/lxiconsLibrary.js";
import { ViewPane, type IViewPaneOptions, type PartTitleProjection } from "../../../browser/parts/views/viewPane.js";
import type { IDebugConsoleService } from "../../../services/debug/common/debugConsoleService.js";
import { CLEAR_DEBUG_CONSOLE_COMMAND_ID } from "../common/debug.js";

/** Panel-owned Debug Console projection for DAP output and REPL evaluation. */
export class DebugConsoleViewPane extends ViewPane {
	private readonly titleActions: ActionBar;
	private readonly sessionSelect: HTMLSelectElement;
	private readonly output: HTMLPreElement;
	private readonly form: HTMLFormElement;
	private readonly input: HTMLInputElement;
	private readonly status: HTMLDivElement;

	constructor(container: HTMLElement, options: IViewPaneOptions, private readonly consoleService: IDebugConsoleService) {
		super(container, options);
		this.contentElement.classList.add("ash-debug-console");
		this.titleActions = this._register(new ActionBar(this.headerActionsElement, { ariaLabel: "Debug Console actions" }));
		this.titleActions.element.classList.add("ash-toolbar");
		this.sessionSelect = h(container.ownerDocument, "select");
		this.sessionSelect.className = "ash-debug-console-session";
		this.sessionSelect.setAttribute("aria-label", "Debug Console session");
		this.output = h(container.ownerDocument, "pre");
		this.output.className = "ash-debug-console-output";
		this.output.tabIndex = 0;
		this.output.setAttribute("role", "log");
		this.output.setAttribute("aria-label", "Debug Console output");
		this.form = h(container.ownerDocument, "form");
		this.form.className = "ash-debug-console-form";
		this.input = h(container.ownerDocument, "input");
		this.input.type = "text";
		this.input.placeholder = "Evaluate expression";
		this.input.setAttribute("aria-label", "Debug Console expression");
		this.form.append(this.input);
		this.status = h(container.ownerDocument, "div");
		this.status.className = "ash-debug-console-status";
		this.status.setAttribute("role", "status");
		this.contentElement.append(this.sessionSelect, this.output, this.form, this.status);
		this._register(addDisposableListener(this.sessionSelect, "change", () => this.selectSession()));
		this._register(addDisposableListener(this.form, "submit", event => { void this.evaluate(event); }));
		this._register(consoleService.onDidChange(() => this.render()));
		this.render();
	}

	override get partTitleProjection(): PartTitleProjection {
		return { actions: this.titleActions.element };
	}

	private selectSession(): void {
		try { this.consoleService.selectSession(this.sessionSelect.value); }
		catch (error) { this.setStatus(message(error)); }
	}

	private async evaluate(event: Event): Promise<void> {
		event.preventDefault();
		const expression = this.input.value;
		if (!expression.trim()) return;
		this.input.value = "";
		try { await this.consoleService.evaluate(expression); this.setStatus(""); }
		catch (error) { this.setStatus(message(error)); }
	}

	private render(): void {
		const active = this.consoleService.activeSession;
		const atEnd = this.output.scrollHeight - this.output.scrollTop - this.output.clientHeight < 8;
		this.sessionSelect.replaceChildren(...this.consoleService.sessions.map(session => option(this.element.ownerDocument, session.id, `${session.label} — ${session.state}`)));
		if (active) this.sessionSelect.value = active.id;
		this.sessionSelect.hidden = this.consoleService.sessions.length < 2;
		this.output.textContent = active?.output ?? "";
		this.input.disabled = !active?.canEvaluate;
		this.input.placeholder = active?.canEvaluate ? "Evaluate expression" : "Start a debug session to evaluate expressions";
		const clearAction: IAction = { id: CLEAR_DEBUG_CONSOLE_COMMAND_ID, label: "Clear Console", tooltip: "Clear Console", icon: lxiconsLibrary.eraser, enabled: Boolean(active?.output), checked: undefined, run: () => this.consoleService.clear() };
		this.titleActions.updateActions([clearAction]);
		if (atEnd) this.output.scrollTop = this.output.scrollHeight;
	}

	private setStatus(value: string): void {
		this.status.textContent = value;
	}
}

function option(document: Document, value: string, label: string): HTMLOptionElement {
	const element = h(document, "option");
	element.value = value;
	element.textContent = label;
	return element;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
