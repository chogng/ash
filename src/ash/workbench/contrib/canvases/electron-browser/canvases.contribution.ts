import '../browser/editorCanvasActions.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { CanvasesEnabledSettingId } from '../../../../platform/agentHost/common/agentService.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import {
	AccessibleViewType,
	AccessibilityVerbositySettingId,
} from '../../../../platform/accessibility/browser/accessibleView.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import {
	Extensions,
	type IConfigurationRegistry,
} from '../../../../platform/configuration/common/configurationRegistry.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { EditorPanes } from '../../../browser/editor.js';
import { EditorPaneMatch } from '../../../browser/parts/editor/editorPane.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import {
	EditorInputSerializers,
	UnknownEditorInputSerializerError,
} from '../../../services/editor/common/editorInputSerializer.js';
import { CanvasInput, ICanvasService, ICanvasContextService } from '../common/canvas.js';
import { CanvasAvailableContext, CanvasOwnerAvailableContext } from '../browser/editorCanvasActions.js';
import { CanvasService } from './canvasService.js';
import { CanvasEditor, SessionCanvasFocusedContext } from './canvasEditor.js';
import { registerCanvasCommands } from './canvasCommands.js';
import { AgentHostCanvasCollection, IAgentHostCanvasCollection } from '../common/agentHostCanvas.js';
import { registerCanvasContextPicker } from '../browser/canvasContextPicker.js';

registerSingleton(ICanvasService, CanvasService, InstantiationType.Delayed);
registerSingleton(IAgentHostCanvasCollection, AgentHostCanvasCollection, InstantiationType.Delayed);
registerCanvasCommands();

for (const [key, title, description] of [
	[
		CanvasesEnabledSettingId,
		localize('canvas.settingTitle', 'Conversation Canvases'),
		localize('canvas.settingDescription', 'Show interactive pages opened by the agent beside their conversations.'),
	],
	[
		AccessibilityVerbositySettingId.SessionCanvas,
		localize('canvas.verbosityTitle', 'Canvas accessibility help'),
		localize(
			'canvas.verbosityDescription',
			'Announce how to open accessibility help when a Canvas receives focus.',
		),
	],
]) {
	Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
		key,
		defaultValue: true,
		parse: value => {
			if (typeof value !== 'boolean') {
				throw new TypeError(localize('canvas.invalidSetting', 'Canvas settings must be boolean.'));
			}
			return value;
		},
		setting: { valueType: 'boolean', title, description },
	});
}

registerWorkbenchContribution('workbench.contrib.canvases', WorkbenchPhase.BlockRestore, accessor => {
	const resources = new DisposableStore();
	const instantiation = accessor.get(IInstantiationService);
	const canvases = accessor.get(ICanvasService);
	const available = CanvasAvailableContext.bindTo(accessor.get(IContextKeyService));
	const ownerAvailable = CanvasOwnerAvailableContext.bindTo(accessor.get(IContextKeyService));
	const contexts = accessor.get(ICanvasContextService);
	resources.add(registerCanvasContextPicker(accessor));
	resources.add(
		autorun(reader =>
			ownerAvailable.set(
				canvases.enabled.read(reader) &&
					contexts.contexts.read(reader).some(context => contexts.isOwnerVisible(context.owner)),
			),
		),
	);
	resources.add(autorun(reader => available.set(canvases.reopenableCanvases.read(reader).length > 0)));
	resources.add(
		EditorPanes.registerEditorPane({
			id: CanvasInput.EDITOR_ID,
			name: localize('canvas.editorName', 'Canvas'),
			canOpen: input => (input instanceof CanvasInput ? EditorPaneMatch.Default : EditorPaneMatch.None),
			create: () => instantiation.createInstance(CanvasEditor),
		}),
	);
	if (!contexts.workingSets) {
		resources.add(
			EditorInputSerializers.register({
				typeId: CanvasInput.ID,
				canSerialize: input => input instanceof CanvasInput,
				serialize: input => (input as CanvasInput).serializationId,
				deserialize: value => {
					const input = typeof value === 'string' ? canvases.restoreCanvasInput(value) : undefined;
					if (!input) {
						throw new UnknownEditorInputSerializerError(CanvasInput.ID);
					}
					return input;
				},
			}),
		);
	}
	for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
		resources.add(
			AccessibleViewRegistry.register({
				type,
				name: 'sessionCanvas-' + type,
				priority: 200,
				when: ContextKeyExpr.has(SessionCanvasFocusedContext.key),
				getProvider: services => {
					const pane = services.get(IEditorService).activeEditorPane;
					return pane instanceof CanvasEditor ? pane.createAccessibleProvider(type) : undefined;
				},
			}),
		);
	}
	return resources;
});
