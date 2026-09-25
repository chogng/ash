import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { JSDOM } from 'jsdom';
import { formatNlsMessage, resetNlsResolver, setNlsResolver } from '../../../../../nls.js';
import { builtinLanguagePackCatalogs } from '../../../../services/localization/common/localizationCatalogs.js';
import { GettingStarted } from '../../browser/gettingStartedContent.js';

suite('Welcome page', () => {
	test('shows actions, translates labels, and dispatches the available action', () => {
		const dom = new JSDOM('<!doctype html><body></body>');
		let openFolderCount = 0;
		const page = new GettingStarted(dom.window.document.body, {
			actions: { openFolder: () => { openFolderCount += 1; } },
			recentProjects: [{ name: 'ash', path: '~/Desktop' }],
		});
		const cards = page.domNode.querySelectorAll<HTMLButtonElement>('.ash-getting-started-card');
		assert.equal(page.domNode.querySelector('.ash-getting-started-name')?.textContent, 'ASH');
		assert.deepEqual([...cards].map(card => card.textContent), ['open folder', 'clone repo', 'connect via ssh', 'connect github↗']);
		assert.deepEqual([...cards].map(card => card.disabled), [false, true, true, true]);
		cards[0]?.click();
		assert.equal(openFolderCount, 1);

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

	test('updates and expands recent projects', () => {
		const dom = new JSDOM('<!doctype html><body></body>');
		const page = new GettingStarted(dom.window.document.body, {
			recentProjects: Array.from({ length: 6 }, (_, index) => ({
				name: `project-${index + 1}`,
				path: `/workspaces/project-${index + 1}`,
			})),
		});
		assert.equal(page.domNode.querySelectorAll('.ash-getting-started-recent-item').length, 5);
		page.domNode.querySelector<HTMLButtonElement>('.ash-getting-started-view-all')?.click();
		assert.equal(page.domNode.querySelectorAll('.ash-getting-started-recent-item').length, 6);
		assert.equal(page.domNode.querySelector('.ash-getting-started-view-all')?.textContent, 'Show less');
		page.setRecentProjects([{ name: 'new-project', path: '/workspaces/new-project' }]);
		assert.equal(page.domNode.querySelectorAll('.ash-getting-started-recent-item').length, 1);
		assert.equal(page.domNode.querySelector<HTMLButtonElement>('.ash-getting-started-view-all')?.disabled, true);
		page.dispose();
		dom.window.close();
	});
});
