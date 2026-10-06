import type { IResourceEditorInput } from '../../../common/editor.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { URI } from '../../../../base/common/uri.js';
import { extUri } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';

const GettingStartedResource = URI.parse('ash-welcome:/welcome');
const GettingStartedContentType = 'application/vnd.ash.welcome';

export function createGettingStartedInput(): IResourceEditorInput {
	return {
		resource: GettingStartedResource,
		contentType: GettingStartedContentType,
		label: localize('gettingStarted.title', 'Welcome'),
		getIcon: () => Lxicon.home,
		readOnly: true,
		showBreadcrumbs: false,
	};
}

export function isGettingStartedInput(input: IResourceEditorInput): boolean {
	return input.contentType === GettingStartedContentType || extUri.isEqual(input.resource, GettingStartedResource);
}
