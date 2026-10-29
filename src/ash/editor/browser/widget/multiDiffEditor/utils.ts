import { type IAction } from '../../../../base/common/actions.js';

/** Binds a visible file header's action to that file, even when another editor is active. */
export function bindActionContext(action: IAction, getContext: () => unknown): IAction {
	return {
		get id() { return action.id; },
		get label() { return action.label; },
		get tooltip() { return action.tooltip; },
		get icon() { return action.icon; },
		get enabled() { return action.enabled; },
		get checked() { return action.checked; },
		run: () => action.run(getContext()),
	};
}
