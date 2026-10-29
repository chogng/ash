import { registerEditorContribution } from '../../../browser/editorFeatureRegistration.js';
import { EditorOption } from '../../../common/config/editorOptions.js';
import { SectionHeadersController } from './sectionHeadersController.js';

registerEditorContribution({
	id: 'editor.contrib.sectionHeaders', install: context => {
		if (context.kind !== 'text' || context.model.largeFile.tooLargeForTokenization || context.options.sectionHeaders === false) return;
		const options = context.options.sectionHeaders || {};
		return new SectionHeadersController(
			context.view,
			context.model,
			context.editor,
			context.configurations,
			() => {
				const minimap = context.editor.getOption(EditorOption.minimap);
				return {
					findRegionSectionHeaders: options.showRegionSectionHeaders ?? minimap.showRegionSectionHeaders,
					findMarkSectionHeaders: options.showMarkSectionHeaders ?? minimap.showMarkSectionHeaders,
					markSectionHeaderRegex: options.markSectionHeaderRegex ?? minimap.markSectionHeaderRegex,
				};
			},
		);
	}
});
