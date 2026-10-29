import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import type { URI } from '../../../../../base/common/uri.js';
import { isHTMLElement } from '../../../../../base/browser/dom.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import type { ChatDebugEditor } from '../chatDebug/chatDebugEditor.js';
import {
	ResumeAgentTraceCommandId,
	createAgentTraceInput,
	readLastAgentTraceResource,
	rememberAgentTraceResource,
	chatDebugEditorId,
	OpenAgentTraceCommandId,
	createAgentTraceResource,
	type AgentTraceLocation,
} from '../chatDebug/chatDebugEditorInput.js';
import {
	AccessibleContentProvider,
	AccessibleViewProviderId,
	AccessibleViewType,
	AccessibilityVerbositySettingId,
} from '../../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { IEditorPart } from '../../../../browser/parts/editor/editorPart.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import {
	Extensions,
	type IConfigurationRegistry,
} from '../../../../../platform/configuration/common/configurationRegistry.js';
import { type ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { EditorPaneMatch } from '../../../../browser/parts/editor/editorPane.js';
import { registerEditorPane } from '../../../../browser/editor.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IChatSessionNavigationService } from '../../../../services/chat/common/chatSessionNavigationService.js';

/** Registers the shared Agent Debug Logs editor and its explicit opening actions. */
export function registerChatOpenAgentDebugPanelAction(): void {
	registerAction2(
		class OpenAgentDebugPanelForSessionAction extends Action2 {
			constructor() {
				super({
					id: 'workbench.action.chat.openAgentDebugPanelForSession',
					title: localize2('chatDebug.showForSession', 'Show Agent Debug Logs'),
					f1: true,
				});
			}
			override async run(accessor: ServicesAccessor, target?: string | AgentTraceLocation): Promise<void> {
				await openAgentTrace(
					accessor,
					createAgentTraceResource(
						target ?? accessor.get(IChatSessionNavigationService).getActiveConversation(),
					),
				);
			}
		},
	);
	registerEditorPane({
		id: chatDebugEditorId,
		name: localize('chatDebugInputName', 'Agent Debug Logs'),
		canOpen: input =>
			input.resource.scheme === 'ash-agent-trace' ? EditorPaneMatch.Default : EditorPaneMatch.None,
		create: async options => {
			if (!options.instantiationService) {
				throw new Error('Execution Trace requires Workbench services');
			}
			const { ChatDebugEditor } = await import('../chatDebug/chatDebugEditor.js');
			return options.instantiationService.createInstance(ChatDebugEditor);
		},
	});

	registerAction2(
		class OpenAgentTrace extends Action2 {
			constructor() {
				super({
					id: OpenAgentTraceCommandId,
					title: localize2('agentTrace.openViewer', 'Open Agent Debug Logs'),
					category: localize2('debugLogs.developer', 'Developer'),
					f1: true,
				});
			}

			public override async run(accessor: ServicesAccessor, target?: string | AgentTraceLocation): Promise<void> {
				await openAgentTrace(accessor, createAgentTraceResource(target));
			}
		},
	);

	Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
		key: AccessibilityVerbositySettingId.AgentTrace,
		defaultValue: true,
		parse: value => {
			if (typeof value !== 'boolean') {
				throw new TypeError(
					localize('agentTrace.invalidVerbosity', 'Trace accessibility verbosity must be boolean.'),
				);
			}
			return value;
		},
		setting: {
			valueType: 'boolean',
			title: localize('agentTrace.verbosity', 'Agent Debug Logs accessibility help'),
			description: localize(
				'agentTrace.verbosityDescription',
				'Announce keyboard help when Agent Debug Logs receives focus.',
			),
		},
	});

	for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
		AccessibleViewRegistry.register({
			type,
			name: `agentTrace.${type}`,
			priority: 100,
			when: ContextKeyExpr.has('agentTraceFocused'),
			getProvider: accessor => {
				const activePane = accessor.get(IEditorPart).activePane;
				if (activePane?.id !== chatDebugEditorId) {
					return undefined;
				}
				const pane = activePane as ChatDebugEditor;
				const focused = accessor.get(ILayoutService).mainContainer.ownerDocument.activeElement;
				return new AccessibleContentProvider(
					AccessibleViewProviderId.AgentTrace,
					{ type },
					() =>
						type === AccessibleViewType.View
							? pane.getAccessibleContent()
							: localize(
									'agentTrace.helpText',
									'Agent Debug Logs\nRead the selected conversation’s saved execution history. Threads contain Turns and execution events; child Threads are nested beneath their parent. Events preserve each Thread’s sequence. A targeted opening selects the requested Thread, Turn or event after its history loads; a missing target is reported. Display filters keep the located event’s details and report when it is hidden. Tab moves between search, the execution tree and detail tabs. Arrow keys, Home and End navigate the tree; Left and Right collapse or expand it. Detail tabs activate with Enter or Space. Overview is the default; Raw record opens a readonly editor on demand. Errors only shows failed Turns, model calls and tool results. Filtering searches identifiers and event contents. Refresh reads newer durable events. Enable request evidence in Execution trace settings, then restart the owning App Server. Model attempts include failures, cancellations and partial output. Input and Output load the selected saved body on demand; choose a body section to read it. Core requests and materialized requests remain distinct, as do complete responses and partial output. Requests are semantic ModelService input, not HTTP bytes. Relations follows recorded model, tool, Code Mode, terminal and child-agent links. More Actions contains Import, Export and Help. Accessible View includes filtered events outside the mounted tree viewport. Model evidence is placed at its recorded Thread prefix when available. Child Threads keep their own sequence. Relations also shows saved child result returns and joins; result-to-model input links require the loaded Core request body. Unknown associations stay unknown. Hiding or closing the editor stops polling and releases subscriptions. Export freezes all loaded events when clicked, including events hidden by the filter. Relationships exclude events and causal evidence outside that capture, with omissions listed in graph warnings. Only one export runs at a time. The last selected import wins even if an earlier file finishes later. Import opens a version 3 rollout trace from an evaluation or another saved capture. Closing the editor releases its live subscriptions. <keybinding:editor.action.accessibleView> reads the trace; Escape closes this help.',
								) +
								'\n' +
								localize(
									'chatDebug.filterHelp',
									'Use commas for alternative text terms and !term to exclude text. Use thread:ID and turn:ID for exact identities. after:YYYY-MM-DD and before:YYYY-MM-DD use inclusive UTC days; ISO timestamps require a time zone. Kind buttons independently show or hide models, tools, agents and other events. Clear filters restores all events. Capture overview is independent of display filters. Each token subtotal shows reported-call coverage; unknown is different from zero. Cached input is included in input tokens. Old imports without a matching backend overview show unknown metrics. In narrow windows, expanding the overview shows it with the event tree; choosing an event restores its details.',
								) +
								'\n' +
								localize(
									'chatDebug.timingHelp',
									'Client timing starts at each model call. First text latency counts the first nonempty body delta, excluding reasoning, metadata and completed snapshots. Generation lasts from first text to call completion and includes transport and local processing. Text TPS estimates non-reasoning output tokens divided by generation duration, not server decode speed; single-chunk responses, tool calls, failures and missing details show unknown. Performance values and unknown reasons are produced by the backend and preserved in exports. Old captures without performance projections stay unknown; the viewer does not recalculate them.',
								),
					() => {
						if (isHTMLElement(focused) && focused.isConnected) {
							focused.focus();
						} else {
							pane.focus();
						}
					},
					AccessibilityVerbositySettingId.AgentTrace,
				);
			},
		});
	}

	async function openAgentTrace(accessor: ServicesAccessor, resource: URI): Promise<void> {
		const storage = accessor.get(IStorageService);
		const editors = accessor.get(IEditorService);
		await editors.openEditor(createAgentTraceInput(resource), { pinned: true });
		rememberAgentTraceResource(storage, resource);
	}

	registerAction2(
		class ResumeAgentTrace extends Action2 {
			constructor() {
				super({
					id: ResumeAgentTraceCommandId,
					title: localize2('agentTrace.resume', 'Resume Agent Debug Logs'),
					f1: true,
				});
			}
			public override async run(accessor: ServicesAccessor): Promise<void> {
				await openAgentTrace(
					accessor,
					readLastAgentTraceResource(accessor.get(IStorageService)) ?? createAgentTraceResource(),
				);
			}
		},
	);
}
