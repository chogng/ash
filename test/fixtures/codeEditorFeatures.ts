import { getEditorFeatures } from '../../src/ash/editor/browser/editorFeatures.js';
import { EditorExtensionsRegistry } from '../../src/ash/editor/browser/editorExtensions.js';

/** Isolated editor fixtures select the same client-owned features installed by product bootstrap. */
export function registerTestCodeEditorFeatures(contributionIds?: readonly string[]) {
    const features = getEditorFeatures();
    return EditorExtensionsRegistry.registerEditorFeatures(contributionIds ? {
        ...features,
        contributions: features.contributions.filter(value => contributionIds.includes(value.id)),
    } : features);
}
