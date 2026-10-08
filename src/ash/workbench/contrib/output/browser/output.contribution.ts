import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ConfigurationScope, Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { IInstantiationService, type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ViewContainerLocation, WorkbenchViewContainerId, ViewsRegistry } from '../../../common/views.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { OutputService } from './outputServices.js';
import { OutputViewPane } from './outputView.js';
import { OutputAccessibilityHelp } from './outputAccessibilityHelp.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from "../../../../platform/actions/common/actions.js";
import { IQuickInputService, type IQuickPickItem } from "../../../../platform/quickinput/common/quickInput.js";
import { IEditorService } from "../../../services/editor/common/editorService.js";
import { IWorkbenchHostService } from "../../../services/host/common/workbenchHostService.js";
import { IOutputService, type IOutputChannel, OUTPUT_MODE_ID, LOG_MODE_ID, CLEAR_OUTPUT_COMMAND_ID, EXPORT_OUTPUT_COMMAND_ID, OPEN_OUTPUT_IN_EDITOR_COMMAND_ID, OUTPUT_VIEW_ID, SHOW_OUTPUT_CHANNELS_COMMAND_ID, SHOW_OUTPUT_COMMAND_ID } from "../../../services/output/common/output.js";
import { IViewsService } from "../../../services/views/common/viewsService.js";

interface OutputChannelQuickPickItem extends IQuickPickItem {
	readonly channel: IOutputChannel;
}

registerAction2(class ShowOutputAction extends Action2 {
	constructor() { super({ id: SHOW_OUTPUT_COMMAND_ID, title: localize2({ bundle: 'ash.workbench', key: 'command.ShowOutputAction' }, "View: Show Output"), f1: true }); }
	override run(accessor: ServicesAccessor): Promise<boolean> { return accessor.get(IViewsService).focusView(OUTPUT_VIEW_ID); }
});

registerAction2(class ShowOutputChannelsAction extends Action2 {
	constructor() { super({ id: SHOW_OUTPUT_CHANNELS_COMMAND_ID, title: localize2({ bundle: 'ash.workbench', key: 'command.ShowOutputChannelsAction' }, "Output: Show Output Channels"), f1: true }); }
	override run(accessor: ServicesAccessor): void {
		const output = accessor.get(IOutputService);
		const picker = accessor.get(IQuickInputService).createQuickPick<OutputChannelQuickPickItem>();
		const disposables = new DisposableStore();
		disposables.add(picker);
		picker.placeholder = localize('output.pickChannel', 'Select an Output channel');
		picker.items = output.channels.map(channel => ({ channel, label: channel.label, description: channel.kind === "log" ? localize('output.log', 'Log') : undefined, detail: channel.descriptor.extensionId }));
		disposables.add(picker.onDidAccept(item => { picker.hide(); output.showChannel(item.channel.id); }));
		disposables.add(picker.onDidHide(() => disposables.dispose()));
		picker.show();
	}
});

registerAction2(class ClearOutputAction extends Action2 {
	constructor() { super({ id: CLEAR_OUTPUT_COMMAND_ID, title: localize2({ bundle: 'ash.workbench', key: 'command.ClearOutputAction' }, "Output: Clear Output"), f1: true }); }
	override run(accessor: ServicesAccessor): void { accessor.get(IOutputService).activeChannel?.clear(); }
});

registerAction2(class OpenOutputInEditorAction extends Action2 {
	constructor() { super({ id: OPEN_OUTPUT_IN_EDITOR_COMMAND_ID, title: localize2({ bundle: 'ash.workbench', key: 'command.OpenOutputInEditorAction' }, "Output: Open Output in Editor"), f1: true }); }
	public override async run(accessor: ServicesAccessor): Promise<void> {
		const channel = accessor.get(IOutputService).activeChannel;
		if (channel) {
			const languageId = channel.descriptor.languageId ?? (channel.kind === 'log' ? LOG_MODE_ID : OUTPUT_MODE_ID);
			await accessor.get(IEditorService).openEditor({ resource: channel.uri, label: channel.label, languageId, readOnly: true });
		}
	}
});

registerAction2(class ExportOutputAction extends Action2 {
	constructor() { super({ id: EXPORT_OUTPUT_COMMAND_ID, title: localize2({ bundle: 'ash.workbench', key: 'command.ExportOutputAction' }, "Output: Export Output…"), f1: true }); }
	override run(accessor: ServicesAccessor): void {
		const channel = accessor.get(IOutputService).activeChannel;
		if (channel) {
			accessor.get(IWorkbenchHostService).downloadText({ fileName: `${channel.label.replace(/[\\/:*?"<>|\u0000-\u001F]/g, "-")}.log`, content: channel.getText(), mediaType: "text/plain;charset=utf-8" });
		}
	}
});

registerSingleton(IOutputService, OutputService, InstantiationType.Delayed);
ViewsRegistry.registerStaticViewContainer({ id: WorkbenchViewContainerId.Output, title: 'Output', localizationKey: { bundle: 'ash.views', key: 'output' }, location: ViewContainerLocation.Panel, order: 2 });
ViewsRegistry.registerStaticViews(WorkbenchViewContainerId.Output, [{ id: OUTPUT_VIEW_ID, title: 'Output', localizationKey: { bundle: 'ash.views', key: 'output' }, order: 1, canToggleVisibility: false, ctorDescriptor: new SyncDescriptor(OutputViewPane) }]);
AccessibleViewRegistry.register(new OutputAccessibilityHelp());

class OutputContribution extends Disposable {
	constructor(@IOutputService output: IOutputService, @IViewsService views: IViewsService) {
		super();
		this._register(output.onDidRequestShowChannel(request => {
			if (request.focus === 'take') {
				void views.focusView(OUTPUT_VIEW_ID).catch(onUnexpectedError);
			} else {
				void views.openView(OUTPUT_VIEW_ID).catch(onUnexpectedError);
			}
		}));
	}
}
registerWorkbenchContribution('workbench.contrib.output', WorkbenchPhase.BlockRestore, accessor => accessor.get(IInstantiationService).createInstance(OutputContribution));

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.Output,
	defaultValue: true,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') {
			throw new TypeError('Output accessibility verbosity must be boolean');
		}
		return value;
	},
	setting: {
		valueType: 'boolean',
		title: localize('output.verbosityTitle', 'Output accessibility help'),
		description: localize('output.verbosityDescription', 'Announce how to open accessibility help when Output receives focus.'),
	},
});

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: 'output.smartScroll.enabled',
	defaultValue: true,
	scope: ConfigurationScope.WINDOW,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') {
			throw new TypeError(localize('output.smartScrollInvalid', 'Output smart scrolling must be a boolean.'));
		}
		return value;
	},
	setting: {
		valueType: 'boolean',
		title: localize('output.smartScrollTitle', 'Output smart scrolling'),
		description: localize('output.smartScrollDescription', 'Pause Auto Scroll when the primary cursor moves to an earlier line, and resume at the last line. Changes apply to the next cursor movement.'),
	},
});
