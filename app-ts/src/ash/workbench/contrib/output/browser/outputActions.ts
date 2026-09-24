import { DisposableStore } from "../../../../base/common/lifecycle.js";
import { Action2, registerAction2 } from "../../../../platform/actions/common/actions.js";
import type { ServicesAccessor } from "../../../../platform/instantiation/common/instantiation.js";
import { IQuickInputService, type IQuickPickItem } from "../../../../platform/quickinput/common/quickInput.js";
import { IEditorService } from "../../../services/editor/common/editorService.js";
import { IWorkbenchHostService } from "../../../services/host/common/workbenchHostService.js";
import { IOutputService, type IOutputChannel } from "../../../services/output/common/outputService.js";
import { IViewsService } from "../../../services/views/browser/viewsService.js";
import { CLEAR_OUTPUT_COMMAND_ID, EXPORT_OUTPUT_COMMAND_ID, OPEN_OUTPUT_IN_EDITOR_COMMAND_ID, OUTPUT_VIEW_ID, SHOW_OUTPUT_CHANNELS_COMMAND_ID, SHOW_OUTPUT_COMMAND_ID } from "../common/output.js";
import { exportOutputChannel, openOutputChannelInEditor } from "./outputOperations.js";

interface OutputChannelQuickPickItem extends IQuickPickItem {
	readonly channel: IOutputChannel;
}

registerAction2(class ShowOutputAction extends Action2 {
	constructor() { super({ id: SHOW_OUTPUT_COMMAND_ID, title: "View: Show Output", f1: true }); }
	override run(accessor: ServicesAccessor): void { accessor.get(IViewsService).focusView(OUTPUT_VIEW_ID); }
});

registerAction2(class ShowOutputChannelsAction extends Action2 {
	constructor() { super({ id: SHOW_OUTPUT_CHANNELS_COMMAND_ID, title: "Output: Show Output Channels", f1: true }); }
	override run(accessor: ServicesAccessor): void {
		const output = accessor.get(IOutputService);
		const picker = accessor.get(IQuickInputService).createQuickPick<OutputChannelQuickPickItem>();
		const disposables = new DisposableStore();
		disposables.add(picker);
		picker.placeholder = "Select an Output channel";
		picker.items = output.channels.map(channel => ({ channel, label: channel.label, description: channel.kind === "log" ? "Log" : undefined, detail: channel.descriptor.extensionId }));
		disposables.add(picker.onDidAccept(item => { picker.hide(); output.showChannel(item.channel.id); }));
		disposables.add(picker.onDidHide(() => disposables.dispose()));
		picker.show();
	}
});

registerAction2(class ClearOutputAction extends Action2 {
	constructor() { super({ id: CLEAR_OUTPUT_COMMAND_ID, title: "Output: Clear Output", f1: true }); }
	override run(accessor: ServicesAccessor): void { accessor.get(IOutputService).activeChannel?.clear(); }
});

registerAction2(class OpenOutputInEditorAction extends Action2 {
	constructor() { super({ id: OPEN_OUTPUT_IN_EDITOR_COMMAND_ID, title: "Output: Open Output in Editor", f1: true }); }
	override run(accessor: ServicesAccessor): void {
		const channel = accessor.get(IOutputService).activeChannel;
		if (channel) void openOutputChannelInEditor(channel, accessor.get(IEditorService));
	}
});

registerAction2(class ExportOutputAction extends Action2 {
	constructor() { super({ id: EXPORT_OUTPUT_COMMAND_ID, title: "Output: Export Output…", f1: true }); }
	override run(accessor: ServicesAccessor): void {
		const channel = accessor.get(IOutputService).activeChannel;
		if (channel) exportOutputChannel(channel, accessor.get(IWorkbenchHostService));
	}
});
