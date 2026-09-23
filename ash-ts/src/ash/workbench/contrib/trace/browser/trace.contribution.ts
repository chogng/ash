import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { ServiceConstructionDescriptor, type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneMatch } from '../../../browser/parts/editor/editorPane.js';
import { registerEditorPane } from '../../../browser/parts/editor/editorRegistry.js';
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
		return options.instantiationService.createInstance(new ServiceConstructionDescriptor(TraceEditor, { serviceDependencies: [IDialogService, IConfigurationService] }));
	},
});

registerWorkbenchContribution('workbench.contrib.trace', WorkbenchPhase.BlockStartup, () => registerAction2(class OpenTraceViewer extends Action2 {
	constructor() { super({ id: 'ash.trace.open', title: localize2('trace.open', 'Developer: Open trace viewer'), f1: true }); }
	override async run(services: ServicesAccessor): Promise<void> {
		await services.get(IEditorService).openEditor({ resource: URI.parse('ash-trace:/viewer'), label: localize('trace.title', 'Trace viewer'), readOnly: true, showBreadcrumbs: false });
	}
}));
