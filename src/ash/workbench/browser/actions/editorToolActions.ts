import { Action2, registerAction2 } from '../../../platform/actions/common/actions.js';
import { IContextKeyService } from '../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr } from '../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';
import { WorkbenchEditorToolsAvailable } from '../../common/contextkeys.js';

/** Apply the document surface condition to palette entries, shortcuts and direct invocations. */
export function registerEditorToolAction(ctor: new () => Action2): void {
	const action = new ctor();
	registerAction2(class extends Action2 {
		constructor() {
			super({ ...action.desc, precondition: ContextKeyExpr.and(WorkbenchEditorToolsAvailable, action.desc.precondition) });
		}

		override run(accessor: ServicesAccessor, ...args: readonly unknown[]): unknown {
			if (accessor.get(IContextKeyService).contextMatchesRules(WorkbenchEditorToolsAvailable)) return action.run(accessor, ...args);
		}
	});
}
