import { URI } from '../../../../base/common/uri.js';
import { extUri } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import type { EditorInput } from '../../../services/editor/common/editorService.js';

const GettingStartedResource = URI.parse('ash-welcome:/welcome');
const GettingStartedContentType = 'application/vnd.ash.welcome';

export function createGettingStartedInput(): EditorInput {
	return {
		resource: GettingStartedResource,
		contentType: GettingStartedContentType,
		label: localize('gettingStarted.title', 'Welcome'),
		readOnly: true,
		showBreadcrumbs: false,
	};
}

export function isGettingStartedInput(input: EditorInput): boolean {
	return input.contentType === GettingStartedContentType || extUri.isEqual(input.resource, GettingStartedResource);
}
