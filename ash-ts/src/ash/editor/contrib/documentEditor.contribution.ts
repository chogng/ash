import { registerEditorContribution } from "../browser/editorExtensions.js";
import { CollaborationContribution } from "./collaboration/browser/collaborationContribution.js";
import { FormattingContribution } from "./formatting/browser/formattingContribution.js";

registerEditorContribution({
	id: "editor.contrib.documentFormatting",
	install: context => {
		if (context.kind !== "document") return;
		context.setFormattingContribution(new FormattingContribution(context.container, {
			documentActions: context.documentActions,
			onToggleMark: context.onToggleMark,
			onSetTextStyle: context.onSetTextStyle,
			onClearTextStyle: context.onClearTextStyle,
			onRunDocumentAction: context.onRunDocumentAction,
		}));
	},
});

registerEditorContribution({
	id: "editor.contrib.collaboration",
	install: context => {
		if (context.kind !== "document") return;
		context.setCollaborationContribution(new CollaborationContribution(context.container, {
			onStart: context.onStartCollaboration,
			onStop: context.onStopCollaboration,
			onInvite: context.onInviteCollaborator,
			onListMembers: context.onListCollaborators,
			onRotateMemberAccessToken: context.onRotateCollaboratorAccessToken,
			onRevokeMember: context.onRevokeCollaborator,
		}));
	},
});
