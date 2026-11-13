import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IEditorPart } from '../../../../workbench/browser/parts/editor/editorPart.js';
import { EditorInputCapabilities } from '../../../../workbench/common/editor.js';
import { ISessionsEntryService, type ISessionsEntry } from '../../../services/layout/common/sessionsEntryService.js';
import { artifactDetailEntry } from '../common/artifactWorkspace.js';
import { ArtifactEditorPane, type ArtifactEditorView } from './artifactEditor.js';
import type { ArtifactWorkspaceRequest } from './artifactWorkspaceRegistry.js';

export async function openArtifacts(accessor: ServicesAccessor, select?: (page: ArtifactEditorView) => void, options: { source?: 'restore'; restoreCommand?: string; reveal?: boolean; } = {}): Promise<void> {
	const editor = accessor.get(IEditorPart);
	const entry: ISessionsEntry = {
		id: 'artifacts.home', workspaceMode: 'chat', activityContext: 'sessions.activity.artifactsSelected', content: 'editor',
		showEditorTabs: false,
		restoreCommand: options.restoreCommand ?? 'sessions.show.artifacts',
		focus: 'editor',
		editorInput: {
			resource: URI.from({ scheme: 'ash-artifacts', path: '/page' }), label: localize('sessions.artifacts.title', 'Artifacts'),
			showBreadcrumbs: false, readOnly: true, capabilities: EditorInputCapabilities.CannotClose,
		},
	};
	let page: ArtifactEditorView | undefined;
	await accessor.get(ISessionsEntryService).openEntry(entry, () => {
		page = (editor.activePane as ArtifactEditorPane).page;
		select?.(page);
		const workspaceId = page.activeWorkspaceId;
		if (workspaceId === undefined) return entry;
		return {
			...entry,
			...artifactDetailEntry,
			id: `artifacts.workspace.${workspaceId}`,
			detailsContainerId: page.detailsContainerId,
		};
	}, { source: options.source });
	if (options.reveal) {
		// Wait for the entry's editor geometry before framing the content.
		page?.revealInitialContent();
	}
}

export function openArtifactWorkspace(accessor: ServicesAccessor, request: ArtifactWorkspaceRequest): Promise<void> {
	return openArtifacts(accessor, page => page.openWorkspace(request), { reveal: true });
}
