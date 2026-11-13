import { Event } from '../../../../base/common/event.js';
import { localize } from '../../../../nls.js';
import { IGeneratedFilesService } from '../../../services/generatedFiles/common/generatedFilesService.js';
import { OPEN_ARTIFACT_CONVERSATION_COMMAND_ID } from '../../chat/common/constants.js';
import { basename } from '../../../../base/common/resources.js';
import { observableFromEvent } from '../../../../base/common/observable.js';
import { IEditorPart } from '../../../../workbench/browser/parts/editor/editorPart.js';
import type { IResourceEditorInput } from '../../../../workbench/common/editor.js';
import { getArtifactTitle } from '../../artifact/browser/artifactKindPresentation.js';
import { registerArtifactCatalogSource, type ArtifactCard } from '../../artifact/browser/artifactWorkspaceRegistry.js';
import { GENERAL_DOCUMENT_CONTENT_TYPE } from '../common/docs.js';
import { ARTIFACT_EXAMPLE_SCHEME } from './documentActions.js';

export function isRetainedDocsInput(input: IResourceEditorInput, generated: IGeneratedFilesService): boolean {
	const { resource, contentType } = input;
	return (contentType === GENERAL_DOCUMENT_CONTENT_TYPE || resource.path.endsWith('.md'))
		&& resource.scheme !== ARTIFACT_EXAMPLE_SCHEME
		&& !generated.isProfileGeneratedPath(resource) && !generated.isGeneratedResource(resource);
}

registerArtifactCatalogSource(accessor => {
	const editors = accessor.get(IEditorPart);
	const generated = accessor.get(IGeneratedFilesService);
	return {
		isRestoring: observableFromEvent(generated, generated.onDidChange, () => generated.loading),
		error: observableFromEvent(generated, generated.onDidChange, () => generated.error),
		cards: observableFromEvent(editors, Event.any(editors.onDidChangeEditors, generated.onDidChange), () => {
			const cards: ArtifactCard[] = generated.files.map(file => ({
				title: file.title,
				kind: 'docs',
				detail: file.contentType === 'text/markdown' ? localize('sessions.artifacts.markdown', 'Markdown') : file.contentType,
				generatedFileResource: file.resource.toString(),
				command: { id: OPEN_ARTIFACT_CONVERSATION_COMMAND_ID, args: [file.id] },
			}));
			const documents = new Set<string>();
			for (const input of editors.groups.flatMap(group => group.editors.map(editor => editor.input))) {
				if (!isRetainedDocsInput(input, generated)) continue;
				// Code and Artifacts can display the same working copy in separate editor groups.
				const identity = input.resource.toString();
				if (documents.has(identity)) continue;
				documents.add(identity);
				cards.push({
					title: input.label ?? basename(input.resource).replace(/\.(?:ash-doc|md)$/u, ''),
					kind: 'docs',
					detail: getArtifactTitle('docs'),
					command: { id: 'sessions.creator.openDocument', args: [identity] },
				});
			}
			return cards;
		}),
	};
});
