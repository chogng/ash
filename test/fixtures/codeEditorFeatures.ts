import { getEditorFeatures } from '../../extensions/code/browser/editor.js';
import { EditorExtensionsRegistry } from '../../src/ash/editor/browser/editorExtensions.js';

/** Isolated editor fixtures explicitly opt in to the same package declarations used by the live bridge. */
export function registerTestCodeEditorFeatures(contributionIds?: readonly string[]) {
    const features = getEditorFeatures();
    return EditorExtensionsRegistry.registerEditorFeatures(contributionIds ? {
        ...features,
        contributions: features.contributions.filter(value => contributionIds.includes(value.id)),
    } : features);
}
