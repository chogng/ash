import { ActionRunner, type IAction } from '../../../../base/common/actions.js';
import { MarshalledId } from '../../../../base/common/marshallingIds.js';
import { getFlatContextMenuActions } from '../../../../platform/actions/browser/menuEntryActionViewItem.js';
import type { IMenu } from '../../../../platform/actions/common/actions.js';
import type { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import type { ISerializedTerminalInstanceContext } from '../common/terminal.js';
import type { ITerminalInstance } from './terminal.js';

/** Menu contexts retain identity without retaining the instance's screen or process. */
export class InstanceContext {
	public readonly instanceId: number;

	constructor(instance: ITerminalInstance) {
		this.instanceId = instance.instanceId;
	}

	public toJSON(): ISerializedTerminalInstanceContext {
		return { $mid: MarshalledId.TerminalContext, instanceId: this.instanceId };
	}
}

export class TerminalContextActionRunner extends ActionRunner {
	protected override async runAction(action: IAction, context?: unknown): Promise<void> {
		if (Array.isArray(context) && context.every(item => item instanceof InstanceContext)) {
			await action.run(context[0], context);
		} else {
			await super.runAction(action, context);
		}
	}
}

export function openContextMenu(
	targetWindow: Window,
	event: MouseEvent,
	contextInstances: ITerminalInstance | readonly ITerminalInstance[] | undefined,
	menu: IMenu,
	contextMenuService: IContextMenuService,
	extraActions: readonly IAction[] = [],
): void {
	event.preventDefault();
	event.stopPropagation();
	const instances = contextInstances === undefined ? [] : Array.isArray(contextInstances) ? contextInstances : [contextInstances as ITerminalInstance];
	const contexts = instances.map(instance => new InstanceContext(instance));
	const actions = [...getFlatContextMenuActions(menu.getActions({ shouldForwardArgs: true }), undefined, targetWindow), ...extraActions];
	const runner = new TerminalContextActionRunner();
	let executing = false;
	let hidden = false;
	runner.onWillRun(() => { executing = true; });
	runner.onDidRun(() => {
		executing = false;
		// Let the host finish its notification and execution cleanup listeners first.
		if (hidden) queueMicrotask(() => runner.dispose());
	});
	try {
		contextMenuService.showContextMenu({
			getAnchor: () => ({ x: event.clientX, y: event.clientY, targetWindow }),
			getActions: () => actions,
			getActionsContext: () => contexts,
			actionRunner: runner,
			onHide: () => { hidden = true; if (!executing) runner.dispose(); },
		});
	} catch (error) {
		runner.dispose();
		throw error;
	}
}
