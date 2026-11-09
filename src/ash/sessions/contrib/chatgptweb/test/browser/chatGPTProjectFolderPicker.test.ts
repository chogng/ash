import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { JSDOM } from 'jsdom';
import { observableValue } from '../../../../../base/common/observable.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IActionWidgetService } from '../../../../../platform/actionWidget/browser/actionWidget.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IProjectsService } from '../../../projects/browser/projectsService.js';
import { ChatGPTProjectFolderPicker } from '../../electron-browser/chatGPTProjectFolderPicker.js';
import { IChatGPTService, type ChatGPTState } from '../../browser/chatGPTService.js';

suite('ChatGPTProjectFolderPicker', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	function fixture() {
		const resources = new DisposableStore();
		const dom = new JSDOM('<!doctype html><body><div id="footer"></div></body>');
		resources.add(toDisposable(() => dom.window.close()));
		const services = resources.add(new InstantiationService());
		const footer = dom.window.document.getElementById('footer')!;
		const visible = observableValue('visible', true);

		const state = observableValue<ChatGPTState>('chatState', {
			connected: true,
			networkAvailable: true,
			projects: [
				{ id: 'p1', title: '智能体harness优化' },
				{ id: 'p2', title: '磁性' },
			],
			conversations: [],
			messages: [],
			coworkTasks: [],
			draft: '',
			activeDraftConversationId: undefined,
			localConversationId: 'local-1',
			draftTarget: undefined,
		} as unknown as ChatGPTState);

		let revision = 0;
		const chatService: Partial<IChatGPTService> = {
			state,
			get newDraftRevision() { return revision; },
			setDraftTarget(target) {
				revision++;
				state.set({ ...state.get(), draftTarget: { ...state.get().draftTarget, ...target } }, undefined);
			},
		};

		services.registerInstance(IChatGPTService, chatService as IChatGPTService);
		services.registerInstance(IFileDialogService, {} as unknown as IFileDialogService);
		services.registerInstance(IFileService, {} as unknown as IFileService);
		services.registerInstance(INotificationService, { error() { } } as unknown as INotificationService);
		services.registerInstance(IProjectsService, {
			state: observableValue('projects', { projects: [] }),
			reload: async () => { },
		} as unknown as IProjectsService);
		services.registerInstance(IActionWidgetService, {
			show() { },
			hide() { },
		} as unknown as IActionWidgetService);

		const picker = resources.add(services.createInstance(ChatGPTProjectFolderPicker, footer, visible));
		const button = footer.querySelector<HTMLButtonElement>('.ash-chat-input-workspace-picker')!;
		const remove = footer.querySelector<HTMLButtonElement>('.ash-chatgpt-project-remove')!;
		const getIconId = () => button.querySelector<HTMLElement>('.ash-icon-label-icon .ash-icon')?.dataset.ashIconId;

		return {
			picker,
			button,
			remove,
			chatService,
			getIconId,
			[Symbol.dispose]() { resources.dispose(); },
		};
	}

	test('shows a filled project icon on the removal control for the selected project', () => {
		using f = fixture();
		const iconSpan = f.button.querySelector('.ash-icon-label-icon')!;
		const labelSpan = f.button.querySelector('.ash-button-label')!;

		// 1. Initial state (no project or folder selected)
		assert.equal(labelSpan.textContent, 'Project or folder');
		assert.ok(iconSpan.querySelector('.ash-icon'), 'Icon element should be present by default');
		assert.equal(f.getIconId(), Lxicon.projects.id);
		assert.ok(f.remove.hidden);

		// 2. Select a project
		f.chatService.setDraftTarget!({ projectId: 'p1' });
		assert.equal(labelSpan.textContent, '智能体harness优化');
		assert.equal(f.getIconId(), undefined);
		assert.equal(f.remove.hidden, false);
		assert.ok(f.remove.querySelector('[data-ash-icon-id="projects-filled"]'));

		// 3. Select a folder as well
		f.chatService.setDraftTarget!({ folder: URI.file('/work/demo') });
		assert.equal(labelSpan.textContent, '智能体harness优化 · demo');
		assert.equal(f.remove.hidden, false);

		// 4. Clear project (only folder remains)
		f.chatService.setDraftTarget!({ projectId: undefined });
		assert.equal(labelSpan.textContent, 'demo');
		assert.equal(f.getIconId(), Lxicon.folder.id);

		// 5. Clear folder (back to default)
		f.chatService.setDraftTarget!({ folder: undefined });
		assert.equal(labelSpan.textContent, 'Project or folder');
		assert.equal(f.getIconId(), Lxicon.projects.id);
	});
});
