import type { URI } from '../../../../../base/common/uri.js';
import type { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { associatedEditorId, type EditorAssociations } from '../../../../browser/parts/editor/editorConfiguration.js';
import { ChatConfiguration } from '../../common/constants.js';

/** Returns the preferred editor for a Chat file link, leaving unmatched files to Workbench. */
export function getEditorOverrideForChatResource(resource: URI, configuration: IConfigurationService | undefined): string | undefined {
	const associations = configuration?.getValue<EditorAssociations>(ChatConfiguration.EditorAssociations);
	return associations && associatedEditorId(`${resource.scheme}:${resource.path}`, associations, true);
}
