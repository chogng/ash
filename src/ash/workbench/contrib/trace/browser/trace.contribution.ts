import { isHTMLElement } from '../../../../base/browser/dom.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { AgentTraceEditor, agentTraceEditorId } from './agentTraceEditor.js';
import { OpenAgentTraceCommandId, createAgentTraceResource, type AgentTraceLocation } from '../common/trace.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IEditorPart } from '../../../browser/parts/editor/editorPart.js';
import { ActiveEditorContext } from '../../../common/contextkeys.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneMatch } from '../../../browser/parts/editor/editorPane.js';
import { registerEditorPane } from '../../../browser/editor.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { TraceEditor, traceEditorId } from './traceEditor.js';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: 'accessibility.verbosity.trace', defaultValue: true,
	parse: value => { if (typeof value !== 'boolean') { throw new TypeError('Trace accessibility verbosity must be boolean'); } return value; },
	setting: { valueType: 'boolean', title: localize('trace.verbosity', 'Trace viewer accessibility help'), description: localize('trace.verbosityDescription', 'Announce the keyboard help hint when the trace viewer receives focus.') },
});

registerEditorPane({
	id: traceEditorId, name: localize('trace.title', 'Trace viewer'),
	canOpen: input => input.resource.toString() === 'ash-trace:/viewer' ? EditorPaneMatch.Default : EditorPaneMatch.None,
	create: options => {
		if (!options.instantiationService) { throw new Error('Trace viewer requires Workbench services'); }
		return options.instantiationService.createInstance(new SyncDescriptor(TraceEditor));
	},
});

registerWorkbenchContribution('workbench.contrib.trace', WorkbenchPhase.BlockStartup, () => registerAction2(class OpenTraceViewer extends Action2 {
	constructor() { super({ id: 'ash.trace.open', title: localize2('trace.open', 'Developer: Open trace viewer'), f1: true }); }
	override async run(services: ServicesAccessor): Promise<void> {
		await services.get(IEditorService).openEditor({ resource: URI.parse('ash-trace:/viewer'), label: localize('trace.title', 'Trace viewer'), readOnly: true, showBreadcrumbs: false });
	}
}));

AccessibleViewRegistry.register({
	type: AccessibleViewType.Help, priority: 100, name: 'traceHelp',
	when: ActiveEditorContext.isEqualTo(traceEditorId),
	getProvider: accessor => {
		if (!(accessor.get(IEditorPart).activePane instanceof TraceEditor)) { return undefined; }
		const focused = accessor.get(ILayoutService).mainContainer.ownerDocument.activeElement;
		return new AccessibleContentProvider(AccessibleViewProviderId.Trace, { type: AccessibleViewType.Help },
			() => localize('trace.helpText', 'Enable tracing before starting App Server: set ASH_TRACE_WEBSOCKET_ADDR to 127.0.0.1:4319 and ASH_TRACE_WEBSOCKET_TOKEN to a random 64-digit hexadecimal token. Enter that address and token here. Only new completed spans are received. Connect starts a new capture; Disconnect keeps the capture. Up to 2,000 spans and 8 MiB are retained; dropped spans are counted. Tab moves between controls. Arrow keys, Home and End select spans. The timeline gives each span’s name, result, relative start and duration as text; Span details contains selectable OTLP JSON with trace and parent IDs. Filtering also limits the OTLP export. Tokens and captures are kept only in this editor. Escape closes this help dialog.'),
			() => { if (focused instanceof HTMLElement && focused.isConnected) { focused.focus(); } }, AccessibilityVerbositySettingId.Trace);
	},
});

registerEditorPane({
	id: agentTraceEditorId,
	name: localize('agentTrace.title', 'Execution Trace'),
	canOpen: input => input.resource.scheme === 'ash-agent-trace' ? EditorPaneMatch.Default : EditorPaneMatch.None,
	create: options => {
		if (!options.instantiationService) { throw new Error('Execution Trace requires Workbench services'); }
		return options.instantiationService.createInstance(AgentTraceEditor);
	},
});

registerAction2(class OpenAgentTrace extends Action2 {
	constructor() {
		super({
			id: OpenAgentTraceCommandId,
			title: localize2('agentTrace.openViewer', 'Developer: Open Execution Trace'),
			f1: true,
		});
	}

	public override async run(accessor: ServicesAccessor, target?: string | AgentTraceLocation): Promise<void> {
		await accessor.get(IEditorService).openEditor({
			resource: createAgentTraceResource(target),
			label: localize('agentTrace.title', 'Execution Trace'),
			readOnly: true,
			showBreadcrumbs: false,
		}, { pinned: true });
	}
});

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.AgentTrace,
	defaultValue: true,
	parse: value => { if (typeof value !== 'boolean') { throw new TypeError(localize('agentTrace.invalidVerbosity', 'Trace accessibility verbosity must be boolean.')); } return value; },
	setting: { valueType: 'boolean', title: localize('agentTrace.verbosity', 'Execution Trace accessibility help'), description: localize('agentTrace.verbosityDescription', 'Announce keyboard help when the execution trace receives focus.') },
});

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.TraceSettings,
	defaultValue: true,
	parse: value => { if (typeof value !== 'boolean') { throw new TypeError(localize({ bundle: 'ash.settings', key: 'trace.invalidVerbosity' }, 'Trace settings accessibility verbosity must be boolean.')); } return value; },
	setting: {
		valueType: 'boolean',
		get title() { return localize({ bundle: 'ash.settings', key: 'trace.verbosity' }, 'Execution trace settings accessibility help'); },
		get description() { return localize({ bundle: 'ash.settings', key: 'trace.verbosityDescription' }, 'Announce how to open accessibility help in execution trace settings.'); },
	},
});

for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
	AccessibleViewRegistry.register({
		type,
		name: `agentTrace.${type}`,
		priority: 100,
		when: ContextKeyExpr.has('agentTraceFocused'),
		getProvider: accessor => {
			const pane = accessor.get(IEditorPart).activePane;
			if (!(pane instanceof AgentTraceEditor)) { return undefined; }
			const focused = accessor.get(ILayoutService).mainContainer.ownerDocument.activeElement;
			return new AccessibleContentProvider(AccessibleViewProviderId.AgentTrace, { type },
				() => type === AccessibleViewType.View ? pane.getAccessibleContent() : localize('agentTrace.helpText', 'Execution Trace\nRead the selected conversation’s saved execution history. Threads contain Turns and execution events; child Threads are nested beneath their parent. Events preserve each Thread’s sequence. A targeted opening selects the requested Thread, Turn or event after its history loads; a missing target is reported. Display filters keep the located event’s details and report when it is hidden. Tab moves between controls, the selected event and selectable JSON details. Arrow keys, Home and End select visible events. Errors only shows failed Turns, model calls and tool results. Filtering searches identifiers and event contents. Refresh reads newer durable events. Enable request evidence in Execution trace settings, then restart the owning App Server. Model attempts include failures, cancellations and partial output. View request / response loads the selected payload. Requests are semantic ModelService input, not HTTP bytes. View relationships follows model, tool, Code Mode, terminal and child-agent links. Diagnostic order is independent from Thread sequences. Hiding or closing the editor stops polling and releases subscriptions. Export saves all loaded events, including events hidden by the filter. Import opens a version 3 rollout trace from an evaluation or another saved capture. Closing the editor releases its live subscriptions. <keybinding:editor.action.accessibleView> reads the trace; Escape closes this help.'),
				() => { if (isHTMLElement(focused) && focused.isConnected) { focused.focus(); } else { pane.focus(); } }, AccessibilityVerbositySettingId.AgentTrace);
		},
	});
}
