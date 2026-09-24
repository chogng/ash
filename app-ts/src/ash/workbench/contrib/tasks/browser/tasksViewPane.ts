import { addDisposableListener, h } from "../../../../base/browser/dom.js";
import { ActionBar } from "../../../../base/browser/ui/actionbar/actionbar.js";
import type { IAction } from "../../../../base/common/actions.js";
import { lxiconsLibrary } from "../../../../base/common/lxiconsLibrary.js";
import { type ITaskRun, type ITaskService, type IWorkspaceTask } from "../../../services/tasks/common/taskService.js";
import { ViewPane, type IViewPaneOptions, type PartTitleProjection } from "../../../browser/parts/views/viewPane.js";
import { TERMINAL_VIEW_ID } from "../../terminal/common/terminal.js";
import { type IViewsService } from "../../../services/views/browser/viewsService.js";
import { type ITerminalService } from "../../../services/terminal/common/terminal.js";

/** Code-owned task catalog and execution status view. */
export class TasksViewPane extends ViewPane {
	private readonly statusElement: HTMLDivElement;
	private readonly listElement: HTMLUListElement;
	private readonly titleActions: ActionBar;
	private renderedTasks: readonly IWorkspaceTask[] = [];
	private refreshing = false;
	private error: string | undefined;

	constructor(container: HTMLElement, options: IViewPaneOptions, private readonly taskService: ITaskService, private readonly viewsService: IViewsService, private readonly terminalService: ITerminalService) {
		super(container, options);
		this.contentElement.classList.add("ash-tasks");
		this.titleActions = this._register(new ActionBar(this.headerActionsElement, { ariaLabel: "Tasks actions" }));
		this.titleActions.element.classList.add("ash-toolbar");
		this.statusElement = h(container.ownerDocument, "div");
		this.statusElement.className = "ash-tasks-status";
		this.statusElement.setAttribute("role", "status");
		this.listElement = h(container.ownerDocument, "ul");
		this.listElement.className = "ash-tasks-list";
		this.listElement.setAttribute("aria-label", "Workspace tasks");
		this.contentElement.append(this.statusElement, this.listElement);
		this._register(addDisposableListener(this.listElement, "click", event => this.activate(event)));
		this._register(taskService.onDidChangeTasks(() => this.render()));
		this._register(taskService.onDidStartTask(() => this.render()));
		this._register(taskService.onDidChangeTaskRun(() => this.render()));
		this.render();
		this.refresh();
	}

	override get partTitleProjection(): PartTitleProjection {
		return { actions: this.titleActions.element };
	}

	private refresh(): void {
		if (this.refreshing) return;
		this.refreshing = true;
		this.error = undefined;
		this.render();
		void this.taskService.refresh().catch(error => {
			this.error = error instanceof Error ? error.message : "Could not read workspace tasks.";
		}).finally(() => {
			this.refreshing = false;
			this.render();
		});
	}

	private activate(event: Event): void {
		const target = event.target;
		if (!(target instanceof this.element.ownerDocument.defaultView!.Element)) return;
		const taskIndex = Number(target.closest<HTMLButtonElement>(".ash-tasks-run")?.dataset.taskIndex);
		if (Number.isSafeInteger(taskIndex) && this.renderedTasks[taskIndex]) {
			void this.taskService.run(this.renderedTasks[taskIndex]!).then(() => this.viewsService.focusView(TERMINAL_VIEW_ID)).catch(error => {
				this.error = error instanceof Error ? error.message : "Could not run task.";
				this.render();
			});
			return;
		}
		const terminalId = target.closest<HTMLButtonElement>(".ash-task-run-button")?.dataset.terminalId;
		if (terminalId) {
			const terminal = this.terminalService.instances.find(candidate => candidate.id === terminalId);
			if (terminal) this.terminalService.setActiveInstance(terminal);
			this.viewsService.focusView(TERMINAL_VIEW_ID);
		}
	}

	private render(): void {
		const refreshAction: IAction = {
			id: "ash.tasks.refresh",
			label: "Refresh Tasks",
			tooltip: "Refresh Tasks",
			icon: lxiconsLibrary.refresh,
			enabled: !this.refreshing,
			checked: undefined,
			run: () => this.refresh(),
		};
		this.titleActions.updateActions([refreshAction]);
		this.renderedTasks = this.taskService.tasks;
		const runs = this.taskService.lastRun ? [this.taskService.lastRun] : [];
		this.listElement.replaceChildren(...this.renderedTasks.map((task, index) => this.renderTask(task, index)), ...runs.map(run => this.renderRun(run)));
		this.statusElement.textContent = this.error ?? (this.refreshing ? "Discovering workspace tasks…" : this.renderedTasks.length === 0 ? "No tasks found. Add .vscode/tasks.json, package.json scripts, or Cargo.toml." : `${this.renderedTasks.length} workspace ${this.renderedTasks.length === 1 ? "task" : "tasks"}.`);
	}

	private renderTask(task: IWorkspaceTask, index: number): HTMLLIElement {
		const item = h(this.element.ownerDocument, "li");
		item.className = "ash-task";
		const button = h(this.element.ownerDocument, "button");
		button.type = "button";
		button.className = "ash-tasks-run";
		button.dataset.taskIndex = String(index);
		const label = h(this.element.ownerDocument, "span");
		label.className = "ash-task-label";
		label.textContent = task.label;
		const source = h(this.element.ownerDocument, "span");
		source.className = "ash-task-source";
		source.textContent = `${task.group} · ${task.source}`;
		const command = h(this.element.ownerDocument, "code");
		command.className = "ash-task-command";
		command.textContent = task.command;
		button.append(label, source, command);
		item.append(button);
		return item;
	}

	private renderRun(run: ITaskRun): HTMLLIElement {
		const item = h(this.element.ownerDocument, "li");
		item.className = `ash-task-run ${run.status}`;
		const button = h(this.element.ownerDocument, "button");
		button.type = "button";
		button.className = "ash-task-run-button";
		button.dataset.terminalId = run.terminal.id;
		button.textContent = `Last: ${run.task.label} — ${run.status}${run.exitCode === undefined ? "" : ` (${run.exitCode})`}`;
		item.append(button);
		return item;
	}
}
