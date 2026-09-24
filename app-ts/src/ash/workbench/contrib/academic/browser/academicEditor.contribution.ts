import { registerEditorPane } from "../../../browser/parts/editor/editorRegistry.js";
import { DocumentEditorPane } from "../../documentEditor/browser/documentEditorPane.js";
import { createDocumentEditorPaneOptions, findEditorProfile, matchEditorProfiles } from "../../documentEditor/browser/editorProfile.js";
import { AppServerDocumentCollaborationService } from "../../../services/documentCollaboration/browser/appServerDocumentCollaborationService.js";
import { DocumentCollaborationService } from "../../../services/documentCollaboration/browser/documentCollaborationService.js";
import { academicProfile } from "./academicEditorProfile.js";

const profiles = [academicProfile] as const;

for (const profile of profiles) {
	registerEditorPane({
		id: profile.editorId,
		name: profile.editorName,
		canOpen: input => matchEditorProfiles(input, [profile]),
		create: options => {
			if (!options.textFileService) throw new Error("Document editor requires the Workbench text file service");
			if (!options.input) throw new Error("Document editor requires its Workbench input during construction");
			const selectedProfile = findEditorProfile(options.input, [profile]);
			if (!selectedProfile) throw new Error("Document editor has no profile for " + options.input.resource.toString());
			const paneOptions = createDocumentEditorPaneOptions(selectedProfile, {
				onSave: options.onSave,
				workingCopyService: options.workingCopyService,
				createDocumentCollaborationService: ownerWindow => {
					const appServerDocumentCollaborationService = options.documentCollaborationApi && options.serverEvents
						? new AppServerDocumentCollaborationService(options.documentCollaborationApi, options.serverEvents)
						: undefined;
					return new DocumentCollaborationService(ownerWindow, appServerDocumentCollaborationService);
				},
			});
			return new DocumentEditorPane(options.textFileService, paneOptions);
		},
	});
}
