import type { Icon } from "./icon.js";
import { Emitter, type Event } from "./event.js";
import { Disposable } from "./lifecycle.js";

/** A resolved action that can be presented by menus, toolbars, and buttons. */
export interface IAction {
	readonly id: string;
	readonly label: string;
	readonly tooltip: string;
	readonly icon?: Icon;
	readonly enabled: boolean;
	readonly checked?: boolean;
	readonly badge?: string;

	run(...args: readonly unknown[]): unknown;
}

export interface IRunEvent {
	readonly action: IAction;
	readonly context?: unknown;
	readonly error?: unknown;
}

export interface IActionRunner {
	readonly onWillRun: Event<IRunEvent>;
	readonly onDidRun: Event<IRunEvent>;

	run(action: IAction, context?: unknown): Promise<void>;
}

/** Runs actions through one observable error boundary. */
export class ActionRunner extends Disposable implements IActionRunner {
	private readonly _onWillRun = this._register(new Emitter<IRunEvent>());
	private readonly _onDidRun = this._register(new Emitter<IRunEvent>());

	readonly onWillRun = this._onWillRun.event;
	readonly onDidRun = this._onDidRun.event;

	async run(action: IAction, context?: unknown): Promise<void> {
		this._onWillRun.fire({ action, context });
		let error: unknown;
		try {
			await action.run(context);
		} catch (cause) {
			error = cause;
		} finally {
			this._onDidRun.fire({ action, context, error });
		}
	}
}

/** A non-interactive separator between groups of actions. */
export class Separator implements IAction {
	static readonly ID = "ash.actions.separator";

	static join(...actionLists: readonly IAction[][]): IAction[] {
		const result: IAction[] = [];
		for (const actions of actionLists) {
			if (actions.length === 0) continue;
			if (result.length > 0) result.push(new Separator());
			result.push(...actions);
		}
		return result;
	}

	readonly id = Separator.ID;
	readonly label = "";
	readonly tooltip = "";
	readonly enabled = false;
	readonly checked = undefined;

	run(): void {}
}

/** An action whose children are rendered as a nested menu. */
export class SubmenuAction implements IAction {
	readonly enabled = true;
	readonly checked = undefined;
	readonly tooltip = "";

	constructor(
		readonly id: string,
		readonly label: string,
		readonly actions: readonly IAction[],
		readonly icon?: Icon,
	) {}

	run(): void {}
}
