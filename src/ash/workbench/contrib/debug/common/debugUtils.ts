import { CancellationError } from '../../../../base/common/errors.js';
import { Schemas } from '../../../../base/common/network.js';
import type { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import type { IEditorService } from '../../../services/editor/common/editorService.js';

/** Applies Debug's save policy through the editor owner before configuration resolution. */
export async function saveAllBeforeDebugStart(
	configurationService: IConfigurationService,
	editorService: IEditorService,
): Promise<void> {
	const policy =
		configurationService.getValue<string>('debug.saveBeforeStart', {
			overrideIdentifier: editorService.activeEditor?.languageId,
		}) ?? 'allEditorsInActiveGroup';
	if (policy !== 'none') {
		const saved = await editorService.saveAll();
		if (!saved.success) {
			throw new CancellationError();
		}
		const activeEditor = editorService.activeEditor;
		if (policy === 'allEditorsInActiveGroup' && activeEditor?.resource.scheme === Schemas.untitled) {
			const group = editorService.activeEditorPane?.group;
			// An untitled input cannot be saved through an unrelated active group.
			if (!group) {
				throw new CancellationError();
			}
			const saved = await editorService.save({ editor: activeEditor, groupId: group.id });
			if (!saved.success) {
				throw new CancellationError();
			}
		}
	}
	await configurationService.reloadConfiguration();
}
