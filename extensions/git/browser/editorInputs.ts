import { createDiffEditorInput as createDiff, createScmMergeEditorInput as createMerge, type IResourceEditorInput, type URI } from '../../../sdk/browser/index.js';
export function createDiffEditorInput(original: IResourceEditorInput, modified: IResourceEditorInput, label: string): IResourceEditorInput {
	// Class accessors are not enumerable; send the two sides explicitly across the Worker boundary.
	return { resource: createDiff(original, modified, label).resource, label, ...{ kind: 'diff', original, modified } };
}
export function createScmMergeEditorInput(repositoryId: string, path: string, resource: URI, resultResource: URI): IResourceEditorInput { return { ...createMerge(repositoryId, path, resource, resultResource), ...{ kind: 'merge' } }; }
