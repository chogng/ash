import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { JSDOM } from 'jsdom';
import { Event } from '../../../../../base/common/event.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import type { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { formatNlsMessage, resetNlsResolver, setNlsResolver } from '../../../../../nls.js';
import { builtinLanguagePackCatalogs } from '../../../../services/localization/common/localizationCatalogs.js';
import { GettingStarted } from '../../browser/gettingStartedContent.js';
import { GettingStartedPage } from '../../browser/gettingStarted.js';
import { GitCloneCommandId } from '../../../git/common/gitCommands.js';
import type { IGitService } from '../../../../contrib/git/common/gitService.js';
import type { IGitHubConnectionService } from '../../../../services/accounts/common/gitHubConnectionService.js';
import type { IRecentWorkspacesService } from '../../../../services/workspaces/common/recentWorkspacesService.js';
import type { IWorkspaceOpenService } from '../../../../services/workspaces/browser/workspaceOpenService.js';

suite('Welcome page', () => {
	test('dispatches the Git clone command from an empty desktop window', async () => {
		const dom = new JSDOM('<!doctype html><body></body>');
		const calls: string[] = [];
		const recent = { onDidChange: Event.None, recentWorkspaces: [] } as unknown as IRecentWorkspacesService;
		const workspace = { canOpenFolder: true, canOpenWorkspace: true } as IWorkspaceOpenService;
		const git = { canCloneRepository: true } as IGitService;
		let commandDispatched: (() => void) | undefined;
		const dispatched = new Promise<void>(resolve => { commandDispatched = resolve; });
		const commands = { executeCommand: async (id: string) => { calls.push(id); commandDispatched?.(); } } as ICommandService;
		using contextKeys = new ContextKeyService();
		using page = new GettingStartedPage(
			recent,
			workspace,
			commands,
			contextKeys,
			{} as IGitHubConnectionService,
			git,
		);
		page.create(dom.window.document.body);
		const clone = [...dom.window.document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Clone repo');
		assert.equal(clone?.disabled, false);
		clone?.click();
		await dispatched;
		assert.deepEqual(calls, [GitCloneCommandId]);
		dom.window.close();
	});
	test('shows actions, translates labels, and dispatches the available action', () => {
		const dom = new JSDOM('<!doctype html><body></body>');
		let openFolderCount = 0;
		let connectGitHubCount = 0;
		const page = new GettingStarted(dom.window.document.body, {
			actions: { openFolder: () => { openFolderCount += 1; }, connectGitHub: () => { connectGitHubCount += 1; } },
			recentProjects: [{ name: 'ash', path: '~/Desktop' }],
		});
		const cards = page.domNode.querySelectorAll<HTMLButtonElement>('.ash-getting-started-card');
		assert.equal(page.domNode.querySelector('.ash-getting-started-name')?.textContent, 'ASH');
		assert.deepEqual([...cards].map(card => card.textContent), ['Open folder', 'Clone repo', 'Connect via SSH', 'Connect GitHub']);
		assert.deepEqual([...cards].map(card => card.disabled), [false, true, true, false]);
		cards[0]?.click();
		cards[3]?.click();
		assert.equal(openFolderCount, 1);
		assert.equal(connectGitHubCount, 1);

		const chinese = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
		try {
			setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
			assert.deepEqual([...cards].map(card => card.querySelector('.ash-getting-started-card-label')?.textContent), ['打开文件夹', '克隆仓库', '通过 SSH 连接', '连接 GitHub']);
			assert.equal(page.domNode.querySelector('h2')?.textContent, '最近的项目');
		} finally {
			resetNlsResolver();
		}
		page.dispose();
		dom.window.close();
	});

	test('shows all recent projects and hides the section when empty', () => {
		const dom = new JSDOM('<!doctype html><body></body>');
		let openCount = 0;
		const page = new GettingStarted(dom.window.document.body, {
			recentProjects: Array.from({ length: 6 }, (_, index) => ({
				name: `project-${index + 1}`,
				path: `/workspaces/project-${index + 1}`,
				onOpen: () => { openCount += 1; },
			})),
		});
		const section = page.domNode.querySelector<HTMLElement>('.ash-getting-started-recent')!;
		const items = section.querySelectorAll<HTMLButtonElement>('.ash-getting-started-recent-item');
		assert.equal(section.hidden, false);
		assert.deepEqual([...items].map(item => [
			item.querySelector('.ash-getting-started-recent-name')?.textContent,
			item.querySelector('.ash-getting-started-recent-path')?.textContent,
		]), Array.from({ length: 6 }, (_, index) => [`project-${index + 1}`, `/workspaces/project-${index + 1}`]));
		assert.equal(section.querySelector('.ash-getting-started-view-all'), null);
		items[0]?.click();
		assert.equal(openCount, 1);
		page.setRecentProjects([]);
		assert.equal(section.hidden, true);
		assert.equal(section.childElementCount, 0);
		items[0]?.click();
		assert.equal(openCount, 1);
		page.setRecentProjects([{ name: 'new-project', path: '/workspaces/new-project' }]);
		assert.equal(section.hidden, false);
		assert.equal(section.querySelector('.ash-getting-started-recent-name')?.textContent, 'new-project');
		assert.equal(section.querySelector('.ash-getting-started-recent-path')?.textContent, '/workspaces/new-project');
		page.dispose();
		dom.window.close();
	});
});
