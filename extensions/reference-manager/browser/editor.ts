import manifest from '../package.json' with { type: 'json' };
import { ReferenceLibraryEditor } from './referenceLibraryEditor.js';
import type { EditorClientInstantiation } from '../../../src/ash/workbench/services/extensions/browser/extensionEditor.js';
import { IFileService } from '../../../src/ash/platform/files/common/files.js';
import { IFileDialogService, IDialogService } from '../../../src/ash/platform/dialogs/common/dialogs.js';
import { IEditorService } from '../../../src/ash/workbench/services/editor/common/editorService.js';
import { IWorkingCopyService } from '../../../src/ash/workbench/services/workingCopy/common/workingCopyService.js';
import { IConfigurationService } from '../../../src/ash/platform/configuration/common/configuration.js';
import { IThemeService } from '../../../src/ash/platform/theme/common/themeService.js';
import { IStorageService } from '../../../src/ash/platform/storage/common/storage.js';
import { LIBRARY_EDITOR_ID } from '../common/library.js';
export const packageId = `${manifest.publisher}.${manifest.name}`;
export const packageVersion = manifest.version;
export function getResourceEditor(id: string, createInstance: EditorClientInstantiation) {
	if (id !== LIBRARY_EDITOR_ID || typeof createInstance !== 'function') throw new TypeError('Incompatible reference library host');
	class LibraryPane extends ReferenceLibraryEditor {
		constructor(
			signal: AbortSignal,
			@IFileService files: IFileService,
			@IFileDialogService fileDialogs: IFileDialogService,
			@IDialogService dialogs: IDialogService,
			@IEditorService editors: IEditorService,
			@IWorkingCopyService copies: IWorkingCopyService,
			@IConfigurationService configuration: IConfigurationService,
			@IThemeService theme: IThemeService,
			@IStorageService storage: IStorageService,
		) {
			super(signal, createInstance, files, fileDialogs, dialogs, editors, copies, configuration, theme, storage);
		}
	}
	return LibraryPane;
}
