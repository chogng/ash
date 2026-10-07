import { registerEditorPane } from "../../../browser/editor.js";
import { DocumentEditorPane } from "./documentEditorPane.js";
import { createDocumentEditorPaneOptions, findEditorProfile, matchEditorProfiles, getEditorProfiles } from './editorProfile.js';
import { DOCUMENT_EDITOR_ID } from './documentEditorInput.js';
import { AppServerDocumentCollaborationService } from "../../../services/documentCollaboration/browser/appServerDocumentCollaborationService.js";
import { DocumentCollaborationService } from "../../../services/documentCollaboration/browser/documentCollaborationService.js";
import { localize } from '../../../../nls.js';
registerEditorPane({
	id: DOCUMENT_EDITOR_ID,
	get name() { return localize('editor.document.name', 'Stanza Document'); },
	canOpen: input => matchEditorProfiles(input, getEditorProfiles()),
	create: options => {
		const instantiationService = options.instantiationService;
		if (!instantiationService) throw new Error("Document editor requires the Workbench instantiation service");
		if (!options.input) throw new Error("Document editor requires its Workbench input during construction");
		const selectedProfile = findEditorProfile(options.input, getEditorProfiles());
		if (!selectedProfile) throw new Error("Document editor has no profile for " + options.input.resource.toString());
		const paneOptions = createDocumentEditorPaneOptions(selectedProfile, {
			onSave: options.onSave,
			createDocumentCollaborationService: () => {
				const appServerDocumentCollaborationService = options.documentCollaborationApi && options.serverEvents
					? new AppServerDocumentCollaborationService(options.documentCollaborationApi, options.serverEvents)
					: undefined;
				return instantiationService.createInstance(DocumentCollaborationService, appServerDocumentCollaborationService);
			},
		});
		return instantiationService.createInstance(DocumentEditorPane, paneOptions);
	},
});
