import { addDisposableListener, h } from "../../../../base/browser/dom.js";
import { type ITestProfile, type ITestRun, type ITestingService } from "../../../services/testing/common/testingService.js";
import { type ITerminalService } from "../../../services/terminal/common/terminal.js";
import { type IViewsService } from "../../../services/views/browser/viewsService.js";
import { ViewPane, type IViewPaneOptions } from "../../../browser/parts/views/viewPane.js";
import { TERMINAL_VIEW_ID } from "../../terminal/common/terminal.js";

/** Test profiles and their latest task-backed run status. */
export class TestingViewPane extends ViewPane {
	private readonly statusElement: HTMLDivElement;
	private readonly profilesElement: HTMLUListElement;
	private renderedProfiles: readonly ITestProfile[] = [];
	private renderedRuns: readonly ITestRun[] = [];
	private error: string | undefined;
	private refreshing = false;

	constructor(container: HTMLElement, options: IViewPaneOptions, private readonly testingService: ITestingService, private readonly terminalService: ITerminalService, private readonly viewsService: IViewsService) {
		super(container, options);
		this.contentElement.classList.add("ash-testing");
		const controls = h(container.ownerDocument, "div");
		controls.className = "ash-testing-controls";
		const runAll = button(container.ownerDocument, "Run All", "ash-testing-run-all");
		const refresh = button(container.ownerDocument, "Refresh", "ash-testing-refresh");
		controls.append(runAll, refresh);
		this.statusElement = h(container.ownerDocument, "div");
		this.statusElement.className = "ash-testing-status";
		this.statusElement.setAttribute("role", "status");
		this.profilesElement = h(container.ownerDocument, "ul");
		this.profilesElement.className = "ash-testing-list";
		this.profilesElement.setAttribute("aria-label", "Test profiles");
		this.contentElement.append(controls, this.statusElement, this.profilesElement);
		this._register(addDisposableListener(runAll, "click", () => this.runAll()));
		this._register(addDisposableListener(refresh, "click", () => this.refresh()));
		this._register(addDisposableListener(this.profilesElement, "click", event => this.activate(event)));
		this._register(testingService.onDidChangeProfiles(() => this.render()));
		this._register(testingService.onDidStartRun(() => this.render()));
		this._register(testingService.onDidChangeRun(() => this.render()));
		this.render();
		this.refresh();
	}

	private refresh(): void {
		if (this.refreshing) return;
		this.refreshing = true;
		this.error = undefined;
		this.render();
		void this.testingService.refresh().catch(error => { this.error = message(error, "Could not discover tests."); }).finally(() => { this.refreshing = false; this.render(); });
	}

	private runAll(): void {
		this.error = undefined;
		void this.testingService.runAll().catch(error => { this.error = message(error, "Could not run tests."); this.render(); });
	}

	private activate(event: Event): void {
		const target = event.target;
		if (!(target instanceof this.element.ownerDocument.defaultView!.Element)) return;
		const profileIndex = Number(target.closest<HTMLButtonElement>(".ash-testing-run")?.dataset.profileIndex);
		if (Number.isSafeInteger(profileIndex) && this.renderedProfiles[profileIndex]) {
			void this.testingService.run(this.renderedProfiles[profileIndex]!).catch(error => { this.error = message(error, "Could not run test profile."); this.render(); });
			return;
		}
		const runIndex = Number(target.closest<HTMLButtonElement>(".ash-testing-run-result")?.dataset.runIndex);
		const run = Number.isSafeInteger(runIndex) ? this.renderedRuns[runIndex] : undefined;
		if (run) {
			this.terminalService.setActiveInstance(run.taskRun.terminal);
			this.viewsService.focusView(TERMINAL_VIEW_ID);
		}
	}

	private render(): void {
		this.renderedProfiles = this.testingService.profiles;
		this.renderedRuns = this.testingService.runs.slice(-20).reverse();
		this.profilesElement.replaceChildren(...this.renderedProfiles.map((profile, index) => renderProfile(this.element.ownerDocument, profile, index)), ...this.renderedRuns.map((run, index) => renderRun(this.element.ownerDocument, run, index)));
		const completed = this.renderedRuns.filter(run => run.status !== "running");
		const passed = completed.filter(run => run.status === "passed").length;
		this.statusElement.textContent = this.error ?? (this.refreshing ? "Discovering tests…" : this.renderedProfiles.length === 0 ? "No test tasks found. Mark a task as the test group or add a test script." : completed.length === 0 ? `${this.renderedProfiles.length} test ${this.renderedProfiles.length === 1 ? "profile" : "profiles"}.` : `${passed} passed, ${completed.length - passed} not passed.`);
	}
}

function renderProfile(document: Document, profile: ITestProfile, index: number): HTMLLIElement {
	const item = h(document, "li");
	item.className = "ash-testing-profile";
	const run = button(document, "Run", "ash-testing-run");
	run.dataset.profileIndex = String(index);
	const label = h(document, "span");
	label.className = "ash-testing-label";
	label.textContent = profile.label;
	const detail = h(document, "span");
	detail.className = "ash-testing-detail";
	detail.textContent = profile.detail ?? profile.source;
	item.append(run, label, detail);
	return item;
}

function renderRun(document: Document, run: ITestRun, index: number): HTMLLIElement {
	const item = h(document, "li");
	item.className = `ash-testing-result ${run.status}`;
	const open = button(document, `${run.profile.label} — ${run.status}`, "ash-testing-run-result");
	open.dataset.runIndex = String(index);
	item.append(open);
	return item;
}

function button(document: Document, label: string, className: string): HTMLButtonElement {
	const element = h(document, "button");
	element.type = "button";
	element.className = className;
	element.textContent = label;
	return element;
}

function message(error: unknown, fallback: string): string {
	return error instanceof Error ? error.message : fallback;
}
