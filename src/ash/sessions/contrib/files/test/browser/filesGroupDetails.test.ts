import '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { browserEnvironment } from '../../../../../editor/test/browser/testEditorDom.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { createTestEditorServices } from '../../../../../workbench/test/common/testEditorServices.js';
import { IEditorPartsService } from '../../../../../workbench/browser/parts/editor/editorParts.js';
import { WorkbenchContributionsRegistry, WorkbenchPhase } from '../../../../../workbench/common/contributions.js';
import { DesktopMainEditorPart } from '../../../../browser/parts/desktopEditorPart.js';
import '../../browser/files.contribution.js';

suite('Files group Details contribution', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('registers a lazy Files factory in its window and releases the registration with the contribution', () => {
		using services = createTestEditorServices(undefined, undefined, browserEnvironment.window.document);
		using editor = services.createInstance(DesktopMainEditorPart, browserEnvironment.window.document.body, {});
		services.registerInstance(IEditorPartsService, { mainPart: editor } as unknown as IEditorPartsService);
		assert.throws(() => editor.filesDetails, /have not been registered/);
		using host = WorkbenchContributionsRegistry.createHost(services, error => { throw error; }, ['sessions.contrib.filesGroupDetails']);
		host.advance(WorkbenchPhase.BlockStartup);
		assert.equal(editor.filesDetailsOpen, false);
		assert.throws(() => editor.registerFilesDetails(() => editor.filesDetails), /already registered/);
		assert.deepEqual(editor.activeGroup.inputs, []);
		host.dispose();
		assert.throws(() => editor.filesDetails, /have not been registered/);
	});
});
