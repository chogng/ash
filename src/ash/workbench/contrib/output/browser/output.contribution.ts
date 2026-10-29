import { IDefaultLogLevelsService } from '../../../services/log/common/defaultLogLevels.js';
import '../../../services/configuration/common/jsonEditingService.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ConfigurationScope, Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { IInstantiationService, type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ViewContainerLocation, WorkbenchViewContainerId, ViewsRegistry, type WorkbenchViewRegistry } from '../../../common/views.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import './outputServices.js';
import { OutputViewPane } from './outputView.js';
import { OutputAccessibilityHelp } from './outputAccessibilityHelp.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWorkbenchHostService } from '../../../services/host/common/workbenchHostService.js';
import { IOutputService, type IOutputChannel, OUTPUT_MODE_ID, LOG_MODE_ID, CLEAR_OUTPUT_COMMAND_ID, EXPORT_OUTPUT_COMMAND_ID, OPEN_OUTPUT_IN_EDITOR_COMMAND_ID, OUTPUT_VIEW_ID, SHOW_OUTPUT_CHANNELS_COMMAND_ID, SHOW_OUTPUT_COMMAND_ID } from '../../../services/output/common/output.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { ILoggerService, type ILogFile } from '../../../../platform/log/common/log.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { CONTEXT_SAVED_LOGS_AVAILABLE, OPEN_SAVED_LOGS_COMMAND_ID } from '../../../services/output/common/output.js';
import { openLogOutput, savedLogLabel } from '../../../services/output/browser/systemOutputService.js';

interface OutputChannelQuickPickItem extends IQuickPickItem {
	readonly channel: IOutputChannel;
}

registerAction2(class SetOutputLogLevelDefaultAction extends Action2 {
	constructor() {
		super({ id: 'workbench.action.output.activeOutputLogLevelDefault', title: localize2('logLevelDefault.label', 'Set As Default') });
	}
	override async run(accessor: ServicesAccessor): Promise<void> {
		const channel = accessor.get(IOutputService).activeChannel;
		const logger = channel?.descriptor.logger?.control;
		if (channel && logger) await accessor.get(IDefaultLogLevelsService).setDefaultLogLevel(logger.getLevel(), channel.descriptor.extensionId);
	}
});

registerAction2(class OpenSavedLogsAction extends Action2 {
	constructor() {
		super({ id: OPEN_SAVED_LOGS_COMMAND_ID, title: localize2({ bundle: 'ash.workbench', key: 'command.OpenSavedLogsAction' }, 'Output: Open Saved Logs…'), f1: true, precondition: CONTEXT_SAVED_LOGS_AVAILABLE.isEqualTo(true) });
	}
	override async run(accessor: ServicesAccessor): Promise<void> {
		const files = accessor.get(ILoggerService).files;
		if (!files) return;
		const output = accessor.get(IOutputService);
		const quickInput = accessor.get(IQuickInputService);
		const sources = await files.list();
		const picker = quickInput.createQuickPick<IQuickPickItem & { readonly source: ILogFile; }>();
		const disposables = new DisposableStore();
		disposables.add(picker);
		picker.placeholder = localize('output.pickSavedLog', 'Select a current or saved log');
		picker.items = sources.map(source => ({ source, label: savedLogLabel(source), description: source.live ? localize('output.liveLog', 'Live') : localize('output.savedLog', 'Saved'), detail: source.id }));
		disposables.add(picker.onDidAccept(() => {
			const item = picker.selectedItems[0];
			if (!item) return;
			picker.hide();
			openLogOutput(output, files, item.source).show();
		}));
		disposables.add(picker.onDidHide(() => disposables.dispose()));
		picker.show();
	}
});

registerAction2(class ShowOutputAction extends Action2 {
	constructor() { super({ id: SHOW_OUTPUT_COMMAND_ID, title: localize2({ bundle: 'ash.workbench', key: 'command.ShowOutputAction' }, 'View: Show Output'), f1: true }); }
	override async run(accessor: ServicesAccessor): Promise<boolean> {
		const channel = accessor.get(IOutputService).activeChannel;
		if (!channel) return accessor.get(IViewsService).focusView(OUTPUT_VIEW_ID);
		channel.show({ focus: 'take' });
		return true;
	}
});

registerAction2(class ShowOutputChannelsAction extends Action2 {
	constructor() { super({ id: SHOW_OUTPUT_CHANNELS_COMMAND_ID, title: localize2({ bundle: 'ash.workbench', key: 'command.ShowOutputChannelsAction' }, 'Output: Show Output Channels'), f1: true }); }
	override run(accessor: ServicesAccessor): void {
		const output = accessor.get(IOutputService);
		const picker = accessor.get(IQuickInputService).createQuickPick<OutputChannelQuickPickItem>();
		const disposables = new DisposableStore();
		disposables.add(picker);
		picker.placeholder = localize('output.pickChannel', 'Select an Output channel');
		picker.items = output.channels.map(channel => ({ channel, label: channel.label, description: channel.kind === 'log' ? localize('output.log', 'Log') : undefined, detail: channel.descriptor.extensionId }));
		disposables.add(picker.onDidAccept(() => {
			const item = picker.selectedItems[0];
			if (!item) return;
			picker.hide(); output.showChannel(item.channel.id);
		}));
		disposables.add(picker.onDidHide(() => disposables.dispose()));
		picker.show();
	}
});

registerAction2(class ClearOutputAction extends Action2 {
	constructor() { super({ id: CLEAR_OUTPUT_COMMAND_ID, title: localize2({ bundle: 'ash.workbench', key: 'command.ClearOutputAction' }, 'Output: Clear Output'), f1: true }); }
	override run(accessor: ServicesAccessor): void { accessor.get(IOutputService).activeChannel?.clear(); }
});

registerAction2(class OpenOutputInEditorAction extends Action2 {
	constructor() { super({ id: OPEN_OUTPUT_IN_EDITOR_COMMAND_ID, title: localize2({ bundle: 'ash.workbench', key: 'command.OpenOutputInEditorAction' }, 'Output: Open Output in Editor'), f1: true }); }
	public override async run(accessor: ServicesAccessor): Promise<void> {
		const channel = accessor.get(IOutputService).activeChannel;
		if (channel) {
			const languageId = channel.descriptor.languageId ?? (channel.kind === 'log' ? LOG_MODE_ID : OUTPUT_MODE_ID);
			await accessor.get(IEditorService).openEditor({ resource: channel.uri, label: channel.label, languageId, readOnly: true });
		}
	}
});

registerAction2(class ExportOutputAction extends Action2 {
	constructor() { super({ id: EXPORT_OUTPUT_COMMAND_ID, title: localize2({ bundle: 'ash.workbench', key: 'command.ExportOutputAction' }, 'Output: Export Output…'), f1: true }); }
	override run(accessor: ServicesAccessor): void {
		const channel = accessor.get(IOutputService).activeChannel;
		if (channel) {
			accessor.get(IWorkbenchHostService).downloadText({ fileName: `${channel.label.replace(/[\\/:*?"<>|\u0000-\u001F]/g, '-')}.log`, content: channel.getText(), mediaType: 'text/plain;charset=utf-8' });
		}
	}
});

/** Each window selects its view registry; importing shared services must not register another host's view commands. */
export function registerOutputView(registry: WorkbenchViewRegistry = ViewsRegistry): void {
	registry.registerStaticViewContainer({ id: WorkbenchViewContainerId.Output, title: 'Output', localizationKey: { bundle: 'ash.views', key: 'output' }, location: ViewContainerLocation.Panel, order: 2 });
	registry.registerStaticViews(WorkbenchViewContainerId.Output, [{ id: OUTPUT_VIEW_ID, title: 'Output', localizationKey: { bundle: 'ash.views', key: 'output' }, order: 1, canToggleVisibility: false, canMoveView: true, ctorDescriptor: new SyncDescriptor(OutputViewPane) }]);
}
AccessibleViewRegistry.register(new OutputAccessibilityHelp());

class OutputContribution extends Disposable {
	constructor(@IOutputService output: IOutputService, @IViewsService views: IViewsService, @ILoggerService loggers: ILoggerService, @IContextKeyService contextKeys: IContextKeyService) {
		super();
		const savedLogs = CONTEXT_SAVED_LOGS_AVAILABLE.bindTo(contextKeys);
		savedLogs.set(Boolean(loggers.files));
		this._register(toDisposable(() => savedLogs.reset()));
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
