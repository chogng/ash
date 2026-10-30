import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { suite, test } from 'mocha';
import { AgentsWindowGraphicVariant } from '../../../common/constants.js';
import { createAgentsBanner } from '../../../browser/agentSessions/agentSessionsBanner.js';
import { formatNlsMessage, resetNlsResolver, setNlsResolver } from '../../../../../../nls.js';
import { productLanguagePackCatalogs } from '../../../../../services/localization/common/localizationCatalogs.js';

suite('Agents banner', () => {
	test('preserves the launch button through graphic changes and releases its listener', () => {
		const dom = new JSDOM('<!doctype html><body></body>');
		let launches = 0;
		let editors = 0;
		const banner = createAgentsBanner(dom.window.document, {
			onButtonClick: () => { launches++; },
			onEditorClick: () => { editors++; },
		});
		dom.window.document.body.append(banner.element);
		try {
			const button = banner.element.querySelector<HTMLButtonElement>('[aria-label="Open Agents window"]')!;
			const editor = banner.element.querySelector<HTMLButtonElement>('[aria-label="Open new editor window"]')!;
			editor.click();
			assert.equal(editors, 1);
			assert.equal(launches, 0);
			assert.equal(banner.element.querySelectorAll('svg[aria-hidden="true"][focusable="false"]').length, 2);
			for (const design of [AgentsWindowGraphicVariant.WindowComparison, AgentsWindowGraphicVariant.ManyWindowsToOne, undefined, AgentsWindowGraphicVariant.WindowComparison] as const) {
				banner.setDesign(design);
				assert.equal(banner.element.querySelector('svg') === null, design === undefined);
				assert.equal(banner.element.querySelector('[aria-label="Open Agents window"]'), button, 'Graphic changes must retain the button listener');
				button.click();
			}
			assert.equal(launches, 4);
			banner.disposables.dispose();
			button.click();
			editor.click();
			assert.equal(launches, 4, 'Disposed introductions must not launch another window');
			assert.equal(editors, 1);
		} finally {
			banner.disposables.dispose();
			dom.window.close();
		}
	});

	test('updates capability and design without replacing the focused button or retaining an old action', () => {
		const dom = new JSDOM('<!doctype html><body></body>');
		let first = 0;
		let second = 0;
		const banner = createAgentsBanner(dom.window.document, {});
		using disposables = banner.disposables;
		dom.window.document.body.append(banner.element);
		try {
			const button = banner.element.querySelector<HTMLButtonElement>('[aria-label="Open Agents window"]')!;
			assert.equal(banner.element.hidden, true);
			banner.setAction(() => { first++; });
			button.focus();
			banner.setDesign(AgentsWindowGraphicVariant.ManyWindowsToOne);
			assert.equal(dom.window.document.activeElement, button);
			button.click();
			banner.setAction(() => { second++; });
			button.click();
			banner.setAction(undefined);
			button.click();
			assert.deepEqual({ first, second, hidden: banner.element.hidden, disabled: button.disabled }, { first: 1, second: 1, hidden: true, disabled: true });
			banner.setDesign(undefined);
			assert.equal(banner.element.querySelectorAll('svg').length, 0);
			banner.setDesign(AgentsWindowGraphicVariant.WindowComparison);
			assert.equal(banner.element.querySelector('[aria-label="Open Agents window"]'), button);
		} finally {
			dom.window.close();
		}
	});

	test('uses Chinese captions and launch text from the product catalog', () => {
		const dom = new JSDOM('<!doctype html><body></body>');
		const chinese = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
		try {
			setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
			const banner = createAgentsBanner(dom.window.document, { onButtonClick: () => { } });
			using disposables = banner.disposables;
			assert.deepEqual([...banner.element.querySelectorAll('h2')].map(title => title.textContent), ['编辑器窗口', '智能体窗口']);
			assert.deepEqual([...banner.element.querySelectorAll('p')].map(description => description.textContent), ['浏览代码，与 AI 一起专注开发。', '集中管理项目和智能体对话。']);
			assert.deepEqual([...banner.element.querySelectorAll('button')].map(button => button.getAttribute('aria-label')), ['新建编辑器窗口', '打开智能体窗口']);
		} finally {
			resetNlsResolver();
			dom.window.close();
		}
	});
});
