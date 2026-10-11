import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import type { ExtensionsPackageSummary } from '../../../../platform/extensionManagement/common/extensionManagementService.js';
import { EditorInputSerializers, requireRecord, requireString, optionalString } from '../../../services/editor/common/editorInputSerializer.js';
import { EditorInput } from '../../../common/editor/editorInput.js';

/** An installed version has a separate identity so actions always target the reviewed installation. */
export class ExtensionsInput extends EditorInput {
	public readonly typeId = 'ash.extensions.input';
	public override readonly editorId = 'ash.extensions.editor';
	public readonly onDidChangeLabel = undefined;
	public readonly readOnly = true;
	public readonly showBreadcrumbs = false;
	public readonly resource: URI;

	constructor(public readonly summary: ExtensionsPackageSummary, public readonly installationId?: string) {
		super();
		this.resource = URI.from({ scheme: Schemas.ashExtension, path: `/${installationId ?? summary.id}`, query: summary.version });
	}

	public getName(): string { return this.summary.displayName; }
}

// Persist identity and inert metadata, then resolve the installation from the backend on restore.
EditorInputSerializers.registerStatic({
	typeId: 'ash.extensions.input',
	canSerialize: input => input instanceof ExtensionsInput,
	serialize: input => {
		if (!(input instanceof ExtensionsInput)) { throw new TypeError('Invalid Extensions input'); }
		return { ...input.summary, installationId: input.installationId };
	},
	deserialize: value => {
		const record = requireRecord(value, 'Extensions input');
		return new ExtensionsInput({
			id: requireString(record.id, 'extension ID'),
			version: requireString(record.version, 'extension version'),
			displayName: requireString(record.displayName, 'extension name'),
			packageType: requireString(record.packageType, 'extension type'),
			description: optionalString(record.description, 'extension description') ?? '',
		}, optionalString(record.installationId, 'extension installation ID'));
	},
});
