import { basename } from '../../../../base/common/resources.js';
import { observableFromEvent } from '../../../../base/common/observable.js';
import { IEditorPart } from '../../../../workbench/browser/parts/editor/editorPart.js';
import { getArtifactTitle } from '../../artifact/browser/artifactKindPresentation.js';
import { registerArtifactCatalogSource, type ArtifactCard } from '../../artifact/browser/artifactWorkspaceRegistry.js';
import { GENERAL_DOCUMENT_CONTENT_TYPE } from '../common/docs.js';
import { ARTIFACT_EXAMPLE_SCHEME } from './documentActions.js';

registerArtifactCatalogSource(accessor => {
	const editors = accessor.get(IEditorPart);
	return {
		cards: observableFromEvent(editors, editors.onDidChangeEditors, () => {
			const cards: ArtifactCard[] = [];
			const documents = new Set<string>();
			for (const input of editors.groups.flatMap(group => group.editors.map(editor => editor.input))) {
				if (input.resource.scheme === ARTIFACT_EXAMPLE_SCHEME) continue;
				if (input.contentType !== GENERAL_DOCUMENT_CONTENT_TYPE && !input.resource.path.endsWith('.md')) continue;
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
