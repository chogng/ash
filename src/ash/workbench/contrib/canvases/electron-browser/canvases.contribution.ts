import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { CanvasesEnabledSettingId } from '../../../../platform/agentHost/common/agentService.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { EditorPanes } from '../../../browser/editor.js';
import { EditorPaneMatch } from '../../../browser/parts/editor/editorPane.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { CanvasInput, ICanvasService } from '../common/canvas.js';
import { CanvasService } from './canvasService.js';
import { CanvasEditor } from './canvasEditor.js';
import { getFocusedCanvasView, SessionCanvasFocusedContext } from './canvasView.js';
import { registerCanvasCommands } from './canvasCommands.js';
import { AgentHostCanvasCollection, IAgentHostCanvasCollection } from '../common/agentHostCanvas.js';

registerSingleton(ICanvasService, CanvasService, InstantiationType.Delayed);
registerSingleton(IAgentHostCanvasCollection, AgentHostCanvasCollection, InstantiationType.Delayed);

for (const [key, title, description] of [
	[CanvasesEnabledSettingId, localize('canvas.settingTitle', 'Conversation Canvases'), localize('canvas.settingDescription', 'Show interactive pages opened by the agent beside their conversations.')],
	[AccessibilityVerbositySettingId.SessionCanvas, localize('canvas.verbosityTitle', 'Canvas accessibility help'), localize('canvas.verbosityDescription', 'Announce how to open accessibility help when a Canvas receives focus.')],
]) {
	Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
		key, defaultValue: true,
		parse: value => { if (typeof value !== 'boolean') { throw new TypeError(localize('canvas.invalidSetting', 'Canvas settings must be boolean.')); } return value; },
		setting: { valueType: 'boolean', title, description },
	});
}

registerWorkbenchContribution('workbench.contrib.canvases', WorkbenchPhase.BlockRestore, accessor => {
	const resources = new DisposableStore();
	const instantiation = accessor.get(IInstantiationService);
	resources.add(registerCanvasCommands(accessor));
	resources.add(EditorPanes.registerEditorPane({
		id: CanvasInput.EDITOR_ID, name: localize('canvas.editorName', 'Canvas'),
		canOpen: input => input instanceof CanvasInput ? EditorPaneMatch.Default : EditorPaneMatch.None,
		create: () => instantiation.createInstance(CanvasEditor),
	}));
	for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
		resources.add(AccessibleViewRegistry.register({
			type, name: 'sessionCanvas-' + type, priority: 200,
			when: ContextKeyExpr.has(SessionCanvasFocusedContext.key),
			getProvider: services => {
				const pane = services.get(IEditorService).activeEditorPane;
				return getFocusedCanvasView()?.createAccessibleProvider(type)
					?? (pane instanceof CanvasEditor ? pane.createAccessibleProvider(type) : undefined);
			},
		}));
	}
	return resources;
});
