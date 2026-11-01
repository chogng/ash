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
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { registerDesktopDetailsTestServices } from '../../../../test/browser/desktopEditorTestServices.js';

suite('Files Part Details contribution', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('registers Files as a normal view in the EditorPart-owned Auxiliary Bar', () => {
		using resources = new DisposableStore();
		using services = createTestEditorServices(undefined, undefined, browserEnvironment.window.document);
		registerDesktopDetailsTestServices(resources, services);
		using editor = services.createInstance(DesktopMainEditorPart, browserEnvironment.window.document.body, {});
		services.registerInstance(IEditorPartsService, { mainPart: editor } as unknown as IEditorPartsService);
		using host = WorkbenchContributionsRegistry.createHost(services, error => { throw error; }, ['sessions.contrib.filesView']);
		host.advance(WorkbenchPhase.BlockStartup);
		const auxiliary = editor.auxiliaryBar;
		assert.equal(editor.detailsOpen, false);
		assert.equal(auxiliary.getCompositeIdToRestore(), 'workbench.sessions.auxiliaryBar.filesContainer');
		assert.deepEqual(editor.activeGroup.inputs, []);
		host.dispose();
		assert.equal(auxiliary.getCompositeIdToRestore(), undefined);
	});
});
