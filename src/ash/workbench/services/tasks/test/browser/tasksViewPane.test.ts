import '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore, Disposable } from '../../../../../base/common/lifecycle.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ITerminalService } from '../../../../contrib/terminal/browser/terminal.js';
import { IViewsService } from '../../../views/common/viewsService.js';
import { ITaskService, type IWorkspaceTask } from '../../common/taskService.js';
import { TasksViewPane } from '../../../../contrib/tasks/browser/tasksViewPane.js';

test('Tasks view clears an execution error when external configuration updates its catalog', async () => {
	using resources = new DisposableStore();
	const changes = resources.add(new Emitter<readonly IWorkspaceTask[]>());
	let catalog: readonly IWorkspaceTask[] = [{ id: 'test', label: 'Check', command: 'check', source: 'vscode', group: 'other', unsupportedFeatures: ['options.cwd'] }];
	const tasks: ITaskService = {
		get tasks() { return catalog; }, activeRuns: [], lastRun: undefined,
		onDidChangeTasks: changes.event, onDidStartTask: Event.None, onDidChangeTaskRun: Event.None,
		registerTaskProvider: () => Disposable.None,
		registerTaskProviders: () => ({ dispose() { }, [Symbol.dispose]() { }, replace() { } }),
		refresh: async () => catalog,
		run: async () => { throw new Error('Task configuration is unsupported.'); },
		terminate: async () => { }, dispose() { }, [Symbol.dispose]() { },
	};
	using services = new InstantiationService();
	services.registerInstance(ITaskService, tasks);
	services.registerInstance(IViewsService, {
		onDidChangeViewContainerVisibility: Event.None, onDidChangeViewVisibility: Event.None, onDidChangeFocusedView: Event.None,
		isViewContainerVisible: () => false, isViewContainerActive: () => false, openViewContainer: async () => null,
		closeViewContainer() { }, getVisibleViewContainer: () => null, getActiveViewPaneContainerWithId: () => null,
		getFocusedView: () => null, getFocusedViewName: () => '', isViewVisible: () => false,
		openView: async () => null, closeView() { }, getActiveViewWithId: () => null, getViewWithId: () => null,
		focusView: async () => true,
	});
	services.registerInstance(ITerminalService, { instances: [] } as unknown as ITerminalService);
	const container = document.createElement('div');
	document.body.append(container);
	try {
		using pane = services.createInstance(TasksViewPane, container, { id: 'test.tasks', title: 'Tasks' });
		container.append(pane.element);
		await new Promise<void>(resolve => setImmediate(resolve));
		pane.element.querySelector<HTMLButtonElement>('.ash-tasks-run')!.click();
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.equal(pane.element.querySelector('.ash-tasks-status')?.textContent, 'Task configuration is unsupported.');
		catalog = [{ ...catalog[0], unsupportedFeatures: [] }];
		changes.fire(catalog);
		assert.equal(pane.element.querySelector('.ash-tasks-status')?.textContent, '1 workspace task.');
	} finally {
		container.remove();
	}
});
