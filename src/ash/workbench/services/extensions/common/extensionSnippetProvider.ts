import { parseSnippet } from '../../../../editor/contrib/snippet/common/snippetParser.js';

/** Expands one file-template snippet to the initial text of an untitled editor. */
export function materializeExtensionFileTemplate(snippet: {
	readonly isFileTemplate?: boolean;
	readonly body: string;
}): string {
	if (!snippet.isFileTemplate) throw new TypeError('Extension file template must declare isFileTemplate');
	return parseSnippet(snippet.body, { allowUnresolvedVariables: true }).text;
}
