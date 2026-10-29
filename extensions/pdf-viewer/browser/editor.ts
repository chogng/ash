import { registerResourceEditorAccessibility } from '../../../src/ash/workbench/services/extensions/browser/resourceEditorAccessibility.js';
import { IConfigurationService } from '../../../src/ash/platform/configuration/common/configuration.js';
import manifest from '../package.json' with { type: 'json' };
import './media/pdfEditor.css';
import { PdfEditorPane } from './pdfEditorPane.js';
import { WorkspacePdfDocumentLoader } from './pdfDocumentLoader.js';
import { WorkspacePdfAnnotationStore } from './pdfAnnotationStore.js';
import { PdfJsRenderer } from './pdfRenderer.js';
import { IFileService } from '../../../src/ash/platform/files/common/files.js';
import { IStorageService } from '../../../src/ash/platform/storage/common/storage.js';
import { IThemeService } from '../../../src/ash/platform/theme/common/themeService.js';

export const packageId = `${manifest.publisher}.${manifest.name}`;
export const packageVersion = manifest.version;

/** The package constructs its own behavior; the host supplies declared services through DI. */
class PackagePdfEditor extends PdfEditorPane {
	constructor(
		signal: AbortSignal,
		@IFileService files: IFileService,
		@IThemeService theme: IThemeService,
		@IStorageService storage: IStorageService,
		@IConfigurationService private readonly configuration: IConfigurationService,
	) {
		super(
			new WorkspacePdfDocumentLoader(files),
			new WorkspacePdfAnnotationStore(files),
			new PdfJsRenderer(),
			theme,
			storage,
		);
		this.bindProvider(signal);
	}

	override create(parent: HTMLElement): void {
		super.create(parent);
		this._register(
			registerResourceEditorAccessibility(
				this.getContainer()!,
				this.configuration,
				() => this.getAccessibleContent(),
				() => this.getAccessibilityHelp(),
			),
		);
	}
}

export function getResourceEditor(editorId: string) {
	if (editorId !== 'ash.workbench.pdfViewer') throw new RangeError(`Unknown PDF editor '${editorId}'`);
	return PackagePdfEditor;
}
