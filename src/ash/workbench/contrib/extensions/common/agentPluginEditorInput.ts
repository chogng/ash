import type { ExtensionsPackageSummary } from '../../../../platform/extensionManagement/common/extensionManagementService.js';
import { optionalString, requireRecord, requireString, type EditorInputSerializer } from '../../../services/editor/common/editorInputSerializer.js';
import { ExtensionsInput, ExtensionsInputSource } from './extensionsInput.js';

/** A local package tab tracks the immutable artifact reviewed by the user. */
export class AgentPluginEditorInput extends ExtensionsInput {
	public override readonly typeId = 'ash.extensions.agentPluginInput';

	constructor(summary: ExtensionsPackageSummary, public readonly digest: string) {
		super(summary, undefined, ExtensionsInputSource.Local, digest);
	}
}

export const agentPluginEditorInputSerializer: EditorInputSerializer = {
	typeId: 'ash.extensions.agentPluginInput',
	canSerialize: input => input instanceof AgentPluginEditorInput,
	serialize: input => {
		if (!(input instanceof AgentPluginEditorInput)) { throw new TypeError('Invalid plugin input'); }
		return { ...input.summary, digest: input.digest };
	},
	deserialize: value => {
		const record = requireRecord(value, 'Plugin input');
		return new AgentPluginEditorInput({
			id: requireString(record.id, 'plugin ID'),
			version: requireString(record.version, 'plugin version'),
			displayName: requireString(record.displayName, 'plugin name'),
			packageType: requireString(record.packageType, 'plugin type'),
			description: optionalString(record.description, 'plugin description') ?? '',
		}, requireString(record.digest, 'plugin digest'));
	},
};
