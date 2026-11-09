import type { Icon } from './icon.js';
import { Emitter, type Event } from './event.js';
import { Disposable } from './lifecycle.js';
import { isLinux, isWindows } from './platform.js';

/** A resolved action that can be presented by menus, toolbars, and buttons. */
export interface IAction {
	readonly id: string;
	readonly label: string;
	readonly tooltip: string;
	readonly icon?: Icon;
	/** CSS foreground for the action glyph, independent of its label and checkmark. */
	readonly iconColor?: string;
	/** Marks an action whose effect can permanently remove or destroy data. */
	readonly destructive?: boolean;
	readonly class?: string;
	readonly enabled: boolean;
	readonly checked?: boolean;
	readonly badge?: string;
	readonly alt?: IAction;
	readonly onDidChange?: Event<IActionChangeEvent | void>;

	run(...args: readonly unknown[]): unknown;
}

export interface IActionChangeEvent {
	readonly label?: string;
	readonly tooltip?: string;
	readonly class?: string;
	readonly enabled?: boolean;
	readonly checked?: boolean;
	readonly icon?: Icon;
}

/** Chooses the executable action from the activation's current modifiers. */
export function getActionForAltMode(action: IAction, modifiers: { readonly altKey?: boolean; readonly shiftKey?: boolean; }): IAction {
	return action.enabled && action.alt?.enabled && (modifiers.altKey || ((isWindows || isLinux) && modifiers.shiftKey))
		? action.alt : action;
}

/** Mutable action state with synchronous notifications for retained views. */
export class Action extends Disposable implements IAction {
	private readonly changed = this._register(new Emitter<IActionChangeEvent>());
	readonly onDidChange = this.changed.event;
	private state: { label: string; tooltip: string; class: string | undefined; enabled: boolean; checked: boolean | undefined; icon: Icon | undefined; };

	constructor(
		readonly id: string,
		label = '',
		cssClass = '',
		enabled = true,
		private readonly callback?: (event?: unknown) => unknown,
	) {
		super();
		this.state = { label, tooltip: '', class: cssClass, enabled, checked: undefined, icon: undefined };
	}

	get label(): string { return this.state.label; }
	set label(value: string) { this.change('label', value); }
	get tooltip(): string { return this.state.tooltip; }
	set tooltip(value: string) { this.change('tooltip', value); }
	get class(): string | undefined { return this.state.class; }
	set class(value: string | undefined) { this.change('class', value); }
	get enabled(): boolean { return this.state.enabled; }
	set enabled(value: boolean) { this.change('enabled', value); }
	get checked(): boolean | undefined { return this.state.checked; }
	set checked(value: boolean | undefined) { this.change('checked', value); }
	get icon(): Icon | undefined { return this.state.icon; }
	set icon(value: Icon | undefined) { this.change('icon', value); }

	run(event?: unknown): unknown { return this.callback?.(event); }

	private change<K extends keyof Action['state']>(key: K, value: Action['state'][K]): void {
		if (this.state[key] === value) return;
		this.state[key] = value;
		this.changed.fire({ [key]: value });
	}
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
			await this.runAction(action, context);
		} catch (cause) {
			error = cause;
		} finally {
			this._onDidRun.fire({ action, context, error });
		}
	}

	protected async runAction(action: IAction, context?: unknown): Promise<void> {
		await action.run(context);
	}
}

/** A non-interactive separator between groups of actions. */
export class Separator implements IAction {
	static readonly ID = 'ash.actions.separator';

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
	readonly label = '';
	readonly tooltip = '';
	readonly enabled = false;
	readonly checked = undefined;

	run(): void { }
}

/** An action whose children are rendered as a nested menu. */
export class SubmenuAction implements IAction {
	readonly enabled = true;
	readonly checked = undefined;
	readonly tooltip: string = '';

	constructor(
		readonly id: string,
		readonly label: string,
		readonly actions: readonly IAction[],
		readonly icon?: Icon,
		/** If present, load fresh children on expansion while showing `actions` as placeholders. */
		readonly loadActions?: () => Promise<readonly IAction[]>,
	) { }

	run(): void { }
}
