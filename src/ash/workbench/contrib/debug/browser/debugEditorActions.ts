import { canSetBreakpointsIn } from '../common/breakpoints.js';
import { IExtensionService } from '../../../services/extensions/common/extensionService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Keybinding, logicalKey } from '../../../../base/common/keybindings.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { EditorContextKeys } from '../../../../editor/common/editorContextKeys.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { localize, localize2 } from '../../../../nls.js';
import {
	IDebugService,
	OPEN_DISASSEMBLY_VIEW_COMMAND_ID,
	BREAKPOINT_EDITOR_CONTRIBUTION_ID,
	BreakpointWidgetContext,
} from '../common/debug.js';
import type { BreakpointEditorContribution } from './breakpointEditorContribution.js';
import { DisassemblyViewInput } from '../common/disassemblyViewInput.js';
import { SubmenuAction } from '../../../../base/common/actions.js';

registerAction2(
	class OpenDisassemblyViewAction extends Action2 {
		constructor() {
			super({
				id: OPEN_DISASSEMBLY_VIEW_COMMAND_ID,
				title: localize2('debug.openDisassembly', 'Open Disassembly View'),
				f1: true,
			});
		}
		public override async run(accessor: ServicesAccessor): Promise<void> {
			const session = accessor.get(IDebugService).session;
			if (!session?.capabilities.supportsDisassembleRequest) {
				throw new Error(
					localize('debug.disassemblyUnsupported', 'The debug adapter does not support disassembly.'),
				);
			}
			if (session.state !== 'stopped') {
				throw new Error(localize('debug.disassemblyRequiresPause', 'Pause debugging to view disassembly.'));
			}
			await accessor.get(IEditorService).openEditor(new DisassemblyViewInput(), { pinned: true });
		}
	},
);

registerAction2(
	class ToggleBreakpointAction extends Action2 {
		constructor() {
			super({
				id: 'editor.debug.action.toggleBreakpoint',
				title: localize2('debug.toggleBreakpoint', 'Toggle Breakpoint'),
				f1: true,
				keybinding: {
					primary: Keybinding.single(logicalKey('F9')),
					when: EditorContextKeys.editorTextFocus.isEqualTo(true),
				},
			});
		}
		override run(accessor: ServicesAccessor): void {
			const editors = accessor.get(ICodeEditorService);
			const editor = editors.getFocusedCodeEditor() ?? editors.getActiveCodeEditor();
			const model = editor?.getModel();
			const position = editor?.getPosition();
			if (
				model &&
				position &&
				canSetBreakpointsIn(
					model.getLanguageId(),
					accessor.get(IExtensionService),
					accessor.get(IConfigurationService),
					accessor.get(IContextKeyService),
				)
			) {
				accessor.get(IDebugService).toggleBreakpoint(model.uri, position.lineNumber);
			}
		}
	},
);

for (const action of [
	{
		id: 'editor.debug.action.conditionalBreakpoint',
		title: localize2('debug.addConditionalBreakpointCommand', 'Debug: Add Conditional Breakpoint...'),
		context: BreakpointWidgetContext.CONDITION,
	},
	{
		id: 'editor.debug.action.addLogPoint',
		title: localize2('debug.addLogpointCommand', 'Debug: Add Logpoint...'),
		context: BreakpointWidgetContext.LOG_MESSAGE,
	},
	{
		id: 'editor.debug.action.editBreakpoint',
		title: localize2('debug.editBreakpointCommand', 'Debug: Edit Breakpoint...'),
		context: undefined,
	},
	{
		id: 'editor.debug.action.moveBreakpoint',
		title: localize2('debug.moveBreakpointCommand', 'Debug: Move Breakpoint...'),
		context: undefined,
	},
])
	registerAction2(
		class extends Action2 {
			constructor() {
				super({ id: action.id, title: action.title, f1: true });
			}
			override async run(accessor: ServicesAccessor): Promise<void> {
				const editors = accessor.get(ICodeEditorService);
				const editor = editors.getFocusedCodeEditor() ?? editors.getActiveCodeEditor();
				const model = editor?.getModel();
				const position = editor?.getPosition();
				const contribution = editor?.getContribution<BreakpointEditorContribution>(
					BREAKPOINT_EDITOR_CONTRIBUTION_ID,
				);
				if (!model || !position || !contribution) return;
				const points = accessor
					.get(IDebugService)
					.breakpoints.filter(
						point =>
							point.resource.toString() === model.uri.toString() &&
							point.lineNumber === position.lineNumber,
					);
				const point =
					points.find(point => point.columnNumber === position.column) ??
					points.find(point => point.columnNumber === undefined) ??
					points[0];
				if (action.id === 'editor.debug.action.moveBreakpoint') {
					const actions = contribution.getContextMenuActionsAtPosition(position.lineNumber, model);
					const submenu = actions.find(action => action.id === point?.id);
					await (submenu instanceof SubmenuAction ? submenu.actions : actions)
						.find(action => action.id === 'debug.moveBreakpoint')
						?.run();
				} else if (point || action.id !== 'editor.debug.action.editBreakpoint') {
					contribution.showBreakpointWidget(position.lineNumber, point?.columnNumber, action.context);
				}
			}
		},
	);
