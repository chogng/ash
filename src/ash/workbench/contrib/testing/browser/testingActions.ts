import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { extUri } from '../../../../base/common/resources.js';
import { localize, localize2 } from '../../../../nls.js';
import { IWorkingCopyService } from '../../../services/workingCopy/common/workingCopyService.js';
import { ITestingService } from '../../../services/testing/common/testingService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { REFRESH_TESTS_COMMAND_ID, RUN_ALL_TESTS_COMMAND_ID, TESTING_VIEW_ID } from '../common/testing.js';

registerAction2(class RunAllTestsAction extends Action2 {
	constructor() {
		super({ id: RUN_ALL_TESTS_COMMAND_ID, title: localize2('testing.runAll', 'Run All Tests'), f1: true, menu: { id: MenuId.MenubarRunMenu, group: '3_testing', order: 1 } });
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const service = accessor.get(ITestingService);
		const notifications = accessor.get(INotificationService);
		try { await accessor.get(IViewsService).focusView(TESTING_VIEW_ID); await service.refreshTests(); await service.runTests(service.tests.map(test => test.key)); }
		catch (error) { notifications.error(String(error)); }
	}
});

registerAction2(class RefreshTestsAction extends Action2 {
	constructor() { super({ id: REFRESH_TESTS_COMMAND_ID, title: localize2('testing.refresh', 'Refresh Tests'), f1: true }); }
	override async run(accessor: ServicesAccessor): Promise<void> {
		const service = accessor.get(ITestingService);
		const notifications = accessor.get(INotificationService);
		try { await service.refresh(); }
		catch (error) { notifications.error(String(error)); }
	}
});

registerAction2(class RunTestAtCursorAction extends Action2 {
	constructor() { super({ id: 'workbench.action.testing.runAtCursor', title: localize2('testing.runAtCursor', 'Run Test on Current Line'), f1: true }); }
	override run(accessor: ServicesAccessor): Promise<void> { return executeTestOnCurrentLine(accessor, 'run'); }
});

registerAction2(class DebugTestAtCursorAction extends Action2 {
	constructor() { super({ id: 'workbench.action.testing.debugAtCursor', title: localize2('testing.debugAtCursor', 'Debug Test on Current Line'), f1: true }); }
	override run(accessor: ServicesAccessor): Promise<void> { return executeTestOnCurrentLine(accessor, 'debug'); }
});

async function executeTestOnCurrentLine(accessor: ServicesAccessor, mode: 'run' | 'debug'): Promise<void> {
	const editors = accessor.get(ICodeEditorService);
	const editor = editors.getFocusedCodeEditor() ?? editors.getActiveCodeEditor();
	const model = editor?.getModel();
	const position = editor?.getPosition();
	const testing = accessor.get(ITestingService);
	const notifications = accessor.get(INotificationService);
	if (!model || !position) { return; }
	if (accessor.get(IWorkingCopyService).get(model.uri).some(copy => copy.isDirty)) {
		notifications.info(localize('testing.saveCursor', 'Save the file and refresh tests before running a test on the current line.'));
		return;
	}
	try {
		const tests = testing.tests.filter(test => test.resource && extUri.isEqual(test.resource, model.uri) && test.source?.line === position.lineNumber);
		if (tests.length === 0) { notifications.info(localize('testing.noTestAtCursor', 'Place the cursor on a discovered test declaration to run it.')); return; }
		if (mode === 'debug') {
			const test = tests.find(test => test.debuggable);
			if (!test) { notifications.info(localize('testing.notDebuggable', 'This test is executed by rustdoc and cannot be launched in a debugger.')); return; }
			await testing.debugTest(test.key);
		} else { await testing.runTests(tests.map(test => test.key)); }
	} catch (error) { notifications.error(String(error)); }
}
