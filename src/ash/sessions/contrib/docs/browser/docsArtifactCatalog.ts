import { IDocsService } from '../common/docsService.js';
import { Event } from '../../../../base/common/event.js';
import { localize } from '../../../../nls.js';
import { IArtifactCatalogService } from '../../../services/artifactCatalog/common/artifactCatalogService.js';
import { OPEN_ARTIFACT_CONVERSATION_COMMAND_ID } from '../../chat/common/constants.js';
import { basename } from '../../../../base/common/resources.js';
import { observableFromEvent } from '../../../../base/common/observable.js';
import { IEditorPart } from '../../../../workbench/browser/parts/editor/editorPart.js';
import type { IResourceEditorInput } from '../../../../workbench/common/editor.js';
import { getArtifactTitle } from '../../artifact/browser/artifactKindPresentation.js';
import { registerArtifactCatalogSource, type ArtifactCard } from '../../artifact/browser/artifactWorkspaceRegistry.js';
import { LEGACY_DOCS_CONTENT_TYPE } from '../common/docs.js';

export function isRetainedDocsInput(input: IResourceEditorInput, generated: IArtifactCatalogService, docs: IDocsService): boolean {
	const { resource, contentType } = input;
	return (contentType === LEGACY_DOCS_CONTENT_TYPE || contentType === 'text/markdown' || /\.md$/iu.test(resource.path))
		&& !docs.isProfileDocumentPath(resource) && !generated.hasResource(resource);
}

registerArtifactCatalogSource(accessor => {
	const editors = accessor.get(IEditorPart);
	const generated = accessor.get(IArtifactCatalogService);
	const docs = accessor.get(IDocsService);
	return {
		isRestoring: observableFromEvent(generated, generated.onDidChange, () => generated.loading),
		error: observableFromEvent(docs, Event.any(generated.onDidChange, docs.onDidChange), () => generated.error ?? docs.error),
		cards: observableFromEvent(editors, Event.any(editors.onDidChangeEditors, generated.onDidChange, docs.onDidChange), () => {
			const cards: ArtifactCard[] = generated.files.filter(file => file.contentType === 'text/markdown' || file.contentType === LEGACY_DOCS_CONTENT_TYPE).map(file => ({
				title: file.title, owner: 'you', resource: file.resource, createdAt: file.createdAt,
				kind: 'docs',
				detail: file.contentType === 'text/markdown' ? localize('sessions.artifacts.markdown', 'Markdown') : file.contentType,
				artifactResource: file.resource.toString(),
				command: { id: OPEN_ARTIFACT_CONVERSATION_COMMAND_ID, args: [file.id] },
			}));
			const documents = new Set<string>();
			for (const input of editors.groups.flatMap(group => group.editors.map(editor => editor.input))) {
				if (!isRetainedDocsInput(input, generated, docs)) continue;
				// Code and Artifacts can display the same working copy in separate editor groups.
				const identity = input.resource.toString();
				if (documents.has(identity)) continue;
				documents.add(identity);
				cards.push({
					title: input.label ?? basename(input.resource).replace(/\.(?:ash-doc|md)$/iu, ''),
					kind: 'docs', owner: 'you', resource: input.resource,
					detail: getArtifactTitle('docs'),
					command: { id: 'sessions.docs.openDocument', args: [identity] },
				});
			}
			return cards;
		}),
	};
});
