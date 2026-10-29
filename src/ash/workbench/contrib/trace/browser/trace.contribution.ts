import { traceEditorId } from '../common/trace.js';
import {
	AccessibleContentProvider,
	AccessibleViewProviderId,
	AccessibleViewType,
	AccessibilityVerbositySettingId,
} from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IEditorPart } from '../../../browser/parts/editor/editorPart.js';
import { ActiveEditorContext } from '../../../common/contextkeys.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import {
	Extensions,
	type IConfigurationRegistry,
} from '../../../../platform/configuration/common/configurationRegistry.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneMatch } from '../../../browser/parts/editor/editorPane.js';
import { registerEditorPane } from '../../../browser/editor.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: 'accessibility.verbosity.trace',
	defaultValue: true,
	parse: value => {
		if (typeof value !== 'boolean') {
			throw new TypeError('Trace accessibility verbosity must be boolean');
		}
		return value;
	},
	setting: {
		valueType: 'boolean',
		title: localize('trace.verbosity', 'Trace viewer accessibility help'),
		description: localize(
			'trace.verbosityDescription',
			'Announce the keyboard help hint when the trace viewer receives focus.',
		),
	},
});

registerEditorPane({
	id: traceEditorId,
	name: localize('trace.title', 'Trace viewer'),
	canOpen: input =>
		input.resource.toString() === 'ash-trace:/viewer' ? EditorPaneMatch.Default : EditorPaneMatch.None,
	create: async options => {
		if (!options.instantiationService) {
			throw new Error('Trace viewer requires Workbench services');
		}
		const { TraceEditor } = await import('./traceEditor.js');
		return options.instantiationService.createInstance(new SyncDescriptor(TraceEditor));
	},
});

registerWorkbenchContribution('workbench.contrib.trace', WorkbenchPhase.BlockStartup, () =>
	registerAction2(
		class OpenTraceViewer extends Action2 {
			constructor() {
				super({
					id: 'ash.trace.open',
					title: localize2('trace.open', 'Developer: Open trace viewer'),
					f1: true,
				});
			}
			override async run(services: ServicesAccessor): Promise<void> {
				await services
					.get(IEditorService)
					.openEditor({
						resource: URI.parse('ash-trace:/viewer'),
						label: localize('trace.title', 'Trace viewer'),
						readOnly: true,
						showBreadcrumbs: false,
					});
			}
		},
	),
);

AccessibleViewRegistry.register({
	type: AccessibleViewType.Help,
	priority: 100,
	name: 'traceHelp',
	when: ActiveEditorContext.isEqualTo(traceEditorId),
	getProvider: accessor => {
		if (accessor.get(IEditorPart).activePane?.id !== traceEditorId) {
			return undefined;
		}
		const focused = accessor.get(ILayoutService).mainContainer.ownerDocument.activeElement;
		return new AccessibleContentProvider(
			AccessibleViewProviderId.Trace,
			{ type: AccessibleViewType.Help },
			() =>
				localize(
					'trace.helpText',
					'Enable tracing before starting App Server: set ASH_TRACE_WEBSOCKET_ADDR to 127.0.0.1:4319 and ASH_TRACE_WEBSOCKET_TOKEN to a random 64-digit hexadecimal token. Enter that address and token here. Only new completed spans are received. Connect starts a new capture; Disconnect keeps the capture. Up to 2,000 spans and 8 MiB are retained; dropped spans are counted. Tab moves between controls. Arrow keys, Home and End select spans. The timeline gives each span’s name, result, relative start and duration as text; Span details contains selectable OTLP JSON with trace and parent IDs. Filtering also limits the OTLP export. Tokens and captures are kept only in this editor. Escape closes this help dialog.',
				),
			() => {
				if (focused instanceof HTMLElement && focused.isConnected) {
					focused.focus();
				}
			},
			AccessibilityVerbositySettingId.Trace,
		);
	},
});

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.TraceSettings,
	defaultValue: true,
	parse: value => {
		if (typeof value !== 'boolean') {
			throw new TypeError(
				localize(
					{ bundle: 'ash.settings', key: 'trace.invalidVerbosity' },
					'Trace settings accessibility verbosity must be boolean.',
				),
			);
		}
		return value;
	},
	setting: {
		valueType: 'boolean',
		get title() {
			return localize(
				{ bundle: 'ash.settings', key: 'trace.verbosity' },
				'Execution trace settings accessibility help',
			);
		},
		get description() {
			return localize(
				{ bundle: 'ash.settings', key: 'trace.verbosityDescription' },
				'Announce how to open accessibility help in execution trace settings.',
			);
		},
	},
});
