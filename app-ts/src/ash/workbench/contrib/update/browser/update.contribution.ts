import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServiceConstructionDescriptor, type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../platform/opener/common/openerService.js';
import { EditorPaneMatch } from '../../../browser/parts/editor/editorPane.js';
import { registerEditorPane } from '../../../browser/parts/editor/editorRegistry.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ILocaleService } from '../../../services/localization/common/locale.js';
import { IOnboardingTryoutService } from '../../onboarding/common/onboardingTryout.js';
import { ReleaseNotesEditor, releaseNotesEditorId, releaseNotesResource } from './releaseNotesEditor.js';

registerEditorPane({
	id: releaseNotesEditorId,
	get name() { return localize('releaseNotes.title', 'Release Notes'); },
	canOpen: input => input.resource.toString() === releaseNotesResource ? EditorPaneMatch.Default : EditorPaneMatch.None,
	create: options => {
		if (!options.instantiationService) throw new Error('Release notes require Workbench services');
		return options.instantiationService.createInstance(new ServiceConstructionDescriptor(ReleaseNotesEditor, { serviceDependencies: [ILocaleService, IOnboardingTryoutService, IOpenerService] }));
	},
});

registerAction2(class ShowReleaseNotes extends Action2 {
	constructor() { super({ id: 'workbench.action.showReleaseNotes', get title() { return localize2('releaseNotes.open', 'Show Release Notes'); }, f1: true, menu: { id: MenuId.MenubarHelpMenu, group: '2_reference', order: 2 } }); }
	override async run(services: ServicesAccessor): Promise<void> {
		await services.get(IEditorService).openEditor({ resource: URI.parse(releaseNotesResource), label: localize('releaseNotes.title', 'Release Notes'), readOnly: true, showBreadcrumbs: false });
	}
});
