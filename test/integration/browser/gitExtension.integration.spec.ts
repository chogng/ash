import { attachRustGit } from './rustGitProcessFixture.js';
import { expect, test, type Page } from '@playwright/test';
import { expectVisibleFocusOutline } from './focusOutline.js';

let stopRust: (() => Promise<void>) | undefined;
test.beforeEach(async ({ page }) => { stopRust = await attachRustGit(page); });
test.afterEach(async () => { await stopRust?.(); stopRust = undefined; });

function collectErrors(page: Page): string[] {
	const errors: string[] = [];
	page.on('pageerror', error => errors.push(error.message));
	page.on('console', message => {
		if (message.type() === 'error' && message.text().startsWith('SCM update failed')) errors.push(message.text());
	});
	return errors;
}

test('Git activates before backend readiness, discovers automatically and waits for discovery on an immediate command', async ({ page }) => {
	const errors = collectErrors(page);
	await page.goto('/gitExtension.html');
	try {
		await page.evaluate(() => window.gitStartupIntegration.hold());
		const runtimes = await page.evaluate(() => window.gitExtensionIntegration.activate('en'));
		expect(runtimes.map(runtime => runtime.lifecycle)).toEqual(['ready']);
		await expect.poll(() => page.evaluate(() => window.gitStartupIntegration.stateReads())).toBeGreaterThan(0);
		expect(await page.evaluate(() => window.gitStartupIntegration.discoveryReads())).toBe(0);
		expect(await page.evaluate(() => window.gitExtensionIntegration.state().repositories)).toEqual([]);
		const command = page.evaluate(() => window.gitExtensionIntegration.invoke('git.stageAll'));
		await page.evaluate(() => window.gitStartupIntegration.releaseState());
		await expect.poll(() => page.evaluate(() => window.gitStartupIntegration.discoveryReads())).toBe(1);
		expect(await page.evaluate(() => window.gitExtensionIntegration.state().calls.some(call => call.method === 'git/stage'))).toBe(false);
		await page.evaluate(() => window.gitStartupIntegration.releaseDiscovery());
		await expect.poll(() => page.evaluate(() => window.gitStartupIntegration.statusReads())).toBeGreaterThan(0);
		expect(await page.evaluate(() => window.gitExtensionIntegration.state().calls.some(call => call.method === 'git/stage'))).toBe(false);
		await page.evaluate(() => window.gitStartupIntegration.releaseStatus());
		await command;
		await expect.poll(() => page.evaluate(() => window.gitExtensionIntegration.state().repositories[0]?.paths)).toEqual(['one.ts']);
		expect(await page.evaluate(() => window.gitExtensionIntegration.state().calls.filter(call => call.method === 'git/stage').length)).toBe(1);
		expect(await page.evaluate(() => window.gitStartupIntegration.discoveryReads())).toBe(1);
		expect(await page.evaluate(() => window.gitStartupIntegration.refresh())).toEqual({ generationPreserved: true, providerPreserved: true });
		expect(await page.evaluate(() => window.gitExtensionIntegration.state().errors)).toEqual([]);
		expect(errors).toEqual([]);
	} finally {
		await page.evaluate(() => { window.gitStartupIntegration.releaseState(); window.gitStartupIntegration.releaseDiscovery(); window.gitStartupIntegration.releaseStatus(); window.gitExtensionIntegration.dispose(); });
	}
});

test('Worker queues a large client request batch without retiring its incarnation', async ({ page }) => {
	const errors = collectErrors(page);
	await page.goto('/gitExtension.html');
	try {
		await page.evaluate(() => window.gitSCMTransportIntegration.holdOutputs());
		const burst = page.evaluate(() => window.gitSCMTransportIntegration.burst());
		await expect.poll(() => page.evaluate(() => window.gitSCMTransportIntegration.waitingOutputs())).toBe(32);
		await page.evaluate(() => window.gitSCMTransportIntegration.releaseOutputs());
		expect(await burst).toEqual(Array.from({ length: 64 }, () => ({ result: 'value', value: null })));
		expect(errors).toEqual([]);
	} finally {
		await page.evaluate(() => { window.gitSCMTransportIntegration.releaseOutputs(); window.gitExtensionIntegration.dispose(); });
	}
});

test('Git presentation settings update the Rust extension without restarting its repositories', async ({ page }) => {
	const errors = collectErrors(page);
	await page.goto('/gitExtension.html');
	try {
		await page.evaluate(() => window.gitExtensionIntegration.activate('en'));
		await expect.poll(() => page.evaluate(() => window.gitExtensionIntegration.state().repositories[0]?.paths)).toEqual(['one.ts']);
		await page.evaluate(() => window.gitPresentationIntegration.addUntracked());
		await expect.poll(() => page.evaluate(() => window.gitExtensionIntegration.state().repositories[0]?.paths)).toEqual(['one.ts', 'new.ts']);
		await page.evaluate(() => window.gitPresentationIntegration.update('git.untrackedChanges', 'separate'));
		await expect.poll(() => page.evaluate(() => window.gitExtensionIntegration.state().repositories[0]?.groups)).toEqual(['Staged Changes', 'Untracked Changes']);
		await page.evaluate(() => window.gitPresentationIntegration.update('git.untrackedChanges', 'hidden'));
		await expect.poll(() => page.evaluate(() => window.gitExtensionIntegration.state().repositories[0]?.paths)).toEqual(['one.ts']);
		expect(await page.evaluate(() => window.gitPresentationIntegration.actions()?.some(id => id.startsWith('openFile:')))).toBe(true);
		await page.evaluate(() => window.gitPresentationIntegration.update('git.showInlineOpenFileAction', false));
		await expect.poll(() => page.evaluate(() => window.gitPresentationIntegration.actions()?.some(id => id.startsWith('openFile:')))).toBe(false);
		await page.evaluate(() => window.gitPresentationIntegration.update('git.decorations.enabled', false));
		await expect.poll(() => page.evaluate(() => window.gitPresentationIntegration.decoration())).toBeUndefined();
		await page.evaluate(() => window.gitPresentationIntegration.update('git.openDiffOnClick', false));
		await page.evaluate(() => window.gitPresentationIntegration.open());
		expect(await page.evaluate(() => window.gitExtensionIntegration.state().requests.filter(request => (request as { method?: string; }).method === 'open').at(-1))).toMatchObject({ method: 'open', input: { resource: 'file:///workspace/one.ts' } });
		await page.evaluate(() => window.gitPresentationIntegration.update('git.untrackedChanges', undefined));
		await expect.poll(() => page.evaluate(() => window.gitExtensionIntegration.state().repositories[0]?.paths)).toEqual(['one.ts', 'new.ts']);
		expect(await page.evaluate(() => window.gitStartupIntegration.refresh())).toEqual({ generationPreserved: true, providerPreserved: true });
		expect(await page.evaluate(() => window.gitExtensionIntegration.state().errors)).toEqual([]);
		expect(errors).toEqual([]);
	} finally { await page.evaluate(() => window.gitExtensionIntegration.dispose()); }
});

test('Git presentation policy crosses the Rust boundary and validates the current commit draft', async ({ page }) => {
	await page.goto('/gitExtension.html');
	try {
		await page.evaluate(() => window.gitExtensionIntegration.activate('en'));
		await expect.poll(() => page.evaluate(() => window.gitExtensionIntegration.state().repositories.length)).toBe(1);
		await page.evaluate(async () => {
			await window.gitPresentationIntegration.update('git.countBadge', 'off');
			await window.gitPresentationIntegration.update('git.showCommitInput', false);
			await window.gitPresentationIntegration.update('git.showActionButton', { commit: false, publish: true, sync: true });
			await window.gitPresentationIntegration.update('git.enableStatusBarSync', false);
			await window.gitPresentationIntegration.update('git.alwaysShowStagedChangesResourceGroup', true);
		});
		await expect.poll(() => page.evaluate(() => window.gitPresentationIntegration.presentation())).toEqual({ count: 0, inputVisible: false, buttonVisible: false, validation: undefined, statusCommands: ['ash.status.git.branch'] });
		await expect.poll(() => page.evaluate(() => window.gitExtensionIntegration.state().repositories[0]?.groups)).toContain('Staged Changes');
		await page.evaluate(async () => {
			await window.gitPresentationIntegration.update('git.showCommitInput', true);
			await window.gitPresentationIntegration.update('git.inputValidation', true);
			await window.gitPresentationIntegration.update('git.inputValidationSubjectLength', 5);
			window.gitPresentationIntegration.draft('long subject');
		});
		await expect.poll(() => page.evaluate(() => window.gitPresentationIntegration.presentation().validation)).toContain('limit of 5');
		await page.evaluate(() => window.gitPresentationIntegration.draft('short'));
		await expect.poll(() => page.evaluate(() => window.gitPresentationIntegration.presentation().validation)).toBeUndefined();
	} finally { await page.evaluate(() => window.gitExtensionIntegration.dispose()); }
});

test('Git commit policies reach the Rust contract through the Rust extension', async ({ page }) => {
	await page.goto('/gitExtension.html');
	try {
		await page.evaluate(() => window.gitExtensionIntegration.activate('en'));
		await expect.poll(() => page.evaluate(() => window.gitExtensionIntegration.state().repositories[0]?.paths)).toEqual(['one.ts']);
		await page.evaluate(async () => {
			await window.gitPresentationIntegration.update('git.enableSmartCommit', true);
			await window.gitPresentationIntegration.update('git.smartCommitChanges', 'tracked');
			await window.gitPresentationIntegration.update('git.enableCommitSigning', true);
			await window.gitPresentationIntegration.update('git.postCommitCommand', 'push');
			await window.gitPresentationIntegration.commit('Signed smart commit');
		});
		expect(await page.evaluate(() => window.gitExtensionIntegration.state().calls.filter(call => call.method === 'git/commit' || call.method === 'git/push'))).toMatchObject([
			{ method: 'git/commit', params: { repositoryId: 'root', message: 'Signed smart commit', scope: 'tracked', signing: 'required', hooks: 'run', identity: 'configured', expectedHead: { type: 'branch', name: 'main', objectId: 'a'.repeat(40), upstream: null } } },
			{ method: 'git/push', params: { repositoryId: 'root', transport: { prune: false, pullTags: true, replaceTags: false, autoStash: false, followTags: false, pushMode: 'normal' } } },
		]);
		await page.evaluate(async () => {
			await window.gitPresentationIntegration.update('git.enableCommitSigning', false);
			await window.gitPresentationIntegration.update('git.postCommitCommand', 'none');
			await window.gitPresentationIntegration.commit('Empty commit', 'git.commitEmpty');
		});
		expect(await page.evaluate(() => window.gitExtensionIntegration.state().calls.filter(call => call.method === 'git/commit').at(-1)?.params)).toMatchObject({ repositoryId: 'root', message: 'Empty commit', scope: 'staged', empty: 'allow', hooks: 'run', identity: 'configured', expectedHead: { type: 'branch', name: 'main', objectId: 'a'.repeat(40), upstream: null } });
		await page.evaluate(async () => {
			await window.gitPresentationIntegration.update('git.fetchOnPull', true);
			await window.gitExtensionIntegration.invoke('git.pullRebase', ['root']);
		});
		expect(await page.evaluate(() => window.gitExtensionIntegration.state().calls.filter(call => call.method === 'git/fetch' || call.method === 'git/pull').map(call => call.method))).toEqual(['git/fetch', 'git/pull']);
		expect(await page.evaluate(() => window.gitExtensionIntegration.state().errors)).toEqual([]);
	} finally { await page.evaluate(() => window.gitExtensionIntegration.dispose()); }
});

test('Git naming, stash, history and repository preferences apply in the Rust extension', async ({ page }) => {
	await page.goto('/gitExtension.html');
	try {
		await page.evaluate(() => window.gitExtensionIntegration.activate('en'));
		await expect.poll(() => page.evaluate(() => window.gitExtensionIntegration.state().repositories[0]?.paths)).toEqual(['one.ts']);
		await page.evaluate(async () => {
			await window.gitPresentationIntegration.update('git.branchPrefix', 'feature/');
			await window.gitPresentationIntegration.update('git.branchWhitespaceChar', '_');
			await window.gitPresentationIntegration.update('git.branchValidationRegex', '^feature/[a-z_]+$');
			window.gitExtensionIntegration.answer(['Invalid!', 'team feature']);
			await window.gitExtensionIntegration.invoke('git.branch', ['root']);
		});
		expect(await page.evaluate(() => window.gitExtensionIntegration.state().calls.find(call => call.method === 'git/branch/create')?.params)).toEqual({ repositoryId: 'root', name: 'feature/team_feature' });
		expect(await page.evaluate(() => window.gitExtensionIntegration.state().requests.some(request => (request as { validationMessage?: string; }).validationMessage?.includes('git.branchValidationRegex')))).toBe(true);
		await page.evaluate(async () => {
			await window.gitPresentationIntegration.update('git.defaultBranchName', 'trunk');
			window.gitExtensionIntegration.answer(['trunk']);
			await window.gitExtensionIntegration.invoke('git.init');
			await window.gitPresentationIntegration.update('git.useCommitInputAsStashMessage', true);
			window.gitPresentationIntegration.draft('Stash draft');
			window.gitExtensionIntegration.answer(['Edited stash']);
			await window.gitExtensionIntegration.invoke('git.stash', ['root']);
		});
		expect(await page.evaluate(() => window.gitExtensionIntegration.state().requests.some(request => (request as { method?: string; value?: string; }).method === 'input' && (request as { value?: string; }).value === 'trunk'))).toBe(true);
		expect(await page.evaluate(() => window.gitExtensionIntegration.state().requests.some(request => (request as { value?: string; }).value === 'Stash draft'))).toBe(true);
		await page.evaluate(() => window.gitPresentationIntegration.update('git.commitShortHashLength', 12));
		expect((await page.evaluate(() => window.gitExtensionIntegration.history()) as { displayId: string; }[])[0]?.displayId).toBe('a'.repeat(12));
		await page.evaluate(() => window.gitPresentationIntegration.update('git.ignoredRepositories', ['/workspace']));
		await expect.poll(() => page.evaluate(() => window.gitExtensionIntegration.state().repositories)).toEqual([]);
		await page.evaluate(() => window.gitPresentationIntegration.update('git.ignoredRepositories', []));
		await expect.poll(() => page.evaluate(() => window.gitExtensionIntegration.state().repositories[0]?.paths)).toEqual(['one.ts']);
		expect(await page.evaluate(() => window.gitExtensionIntegration.state().errors)).toEqual([]);
	} finally { await page.evaluate(() => window.gitExtensionIntegration.dispose()); }
});

test('SCM delivers changes queued while its initialization update is in flight', async ({ page }) => {
	const errors = collectErrors(page);
	await page.goto('/gitExtension.html');
	try {
		await page.evaluate(() => window.gitSCMTransportIntegration.hold());
		await page.evaluate(() => window.gitExtensionIntegration.activate('en'));
		await expect.poll(() => page.evaluate(() => window.gitSCMTransportIntegration.waiting())).toBe(1);
		await page.evaluate(() => window.gitExtensionIntegration.stage());
		await page.evaluate(() => window.gitSCMTransportIntegration.release());
		await expect.poll(async () => ({ groups: await page.evaluate(() => window.gitExtensionIntegration.state().repositories[0]?.groups), errors: [...errors] })).toEqual({ groups: ['Staged Changes'], errors: [] });
		expect(errors).toEqual([]);
		expect((await page.evaluate(() => window.gitExtensionIntegration.state())).errors).toEqual([]);
	} finally {
		await page.evaluate(() => { window.gitSCMTransportIntegration.release(); window.gitExtensionIntegration.dispose(); });
	}
});

test('SCM commit form stays borderless with and without resource groups across themes', async ({ page }, testInfo) => {
	await page.goto('/gitExtension.html');
	try {
		await page.evaluate(() => window.gitExtensionIntegration.activate('en'));
		await expect.poll(() => page.evaluate(() => window.gitExtensionIntegration.state().repositories[0]?.paths)).toEqual(['one.ts']);
		await page.evaluate(() => window.gitScmPaneIntegration.mount());
		const form = page.locator('#scm-pane .ash-scm-commit-form');
		const tree = page.locator('#scm-pane').getByRole('tree', { name: 'Source control changes', exact: true });
		await expect(form).toBeVisible();
		for (const theme of ['dark', 'light', 'hcDark', 'hcLight'] as const) {
			await page.evaluate(theme => window.gitScmPaneIntegration.setTheme(theme), theme);
			await expect(tree.locator('.ash-scm-change')).toHaveCount(1);
			const rowGeometry = await tree.getByRole('treeitem').evaluateAll(elements => elements.map(element => ({
				height: element.getBoundingClientRect().height,
				lineHeight: getComputedStyle(element).lineHeight,
				contentHeight: element.querySelector('.ash-scm-section-heading, .ash-scm-change, .ash-scm-folder')!.getBoundingClientRect().height,
			})));
			expect(rowGeometry.length).toBeGreaterThan(0);
			for (const row of rowGeometry) expect(row).toEqual({ height: 24, lineHeight: '24px', contentHeight: 24 });
			const iconActions = tree.locator('.ash-toolbar .ash-action-view-item.icon > .ash-button');
			expect(await iconActions.count()).toBeGreaterThan(0);
			for (const action of await iconActions.all()) {
				await expect(action).toHaveCSS('width', '24px');
				await expect(action).toHaveCSS('height', '24px');
				await expect(action.locator('.ash-icon').first()).toHaveCSS('width', '16px');
			}
			await expect(form).toHaveCSS('border-bottom-width', '0px');
			await page.evaluate(() => window.gitScmPaneIntegration.setClean(true));
			await expect(tree.getByRole('treeitem')).toHaveCount(0);
			await expect(form).toHaveCSS('border-bottom-width', '0px');
			const boundaries = await page.locator('#scm-pane .ash-split-view-pane').evaluateAll(panes => panes.slice(1).map(pane => getComputedStyle(pane, '::before').height));
			expect(boundaries).toEqual(['1px', '1px']);
			await page.evaluate(() => window.gitScmPaneIntegration.setClean(false));
			await expect(tree.locator('.ash-scm-change')).toHaveCount(1);
			await expect(form).toHaveCSS('border-bottom-width', '0px');
			const resource = tree.locator('.ash-scm-change');
			await resource.hover();
			const actions = resource.locator('.ash-scm-change-actions');
			await expect(actions).toBeVisible();
			const fileGeometry = await resource.evaluate(element => {
				const toolbar = element.querySelector('.ash-scm-change-actions')!;
				const fade = getComputedStyle(toolbar, '::before');
				return {
					actionsRight: toolbar.getBoundingClientRect().right,
					statusLeft: element.querySelector('.ash-scm-change-status')!.getBoundingClientRect().left,
					mask: fade.maskImage, pointerEvents: fade.pointerEvents,
				};
			});
			expect(fileGeometry.actionsRight).toBeLessThanOrEqual(fileGeometry.statusLeft);
			expect(fileGeometry.mask).toContain('linear-gradient');
			expect(fileGeometry.pointerEvents).toBe('none');
			await actions.getByRole('button').first().focus();
			await expect(actions).toBeVisible();
			const heading = tree.locator('.ash-scm-section-heading');
			await heading.hover();
			await tree.focus();
			await page.keyboard.press('Home');
			await expectVisibleFocusOutline(tree.locator('.ash-tree-row.focused'));
			await page.keyboard.press('ArrowDown');
			await resource.hover();
			await expectVisibleFocusOutline(tree.locator('.ash-tree-row.focused'));
			await actions.getByRole('button').first().click({ trial: true });
			await actions.getByRole('button').first().focus();
			await expect(actions).toBeVisible();
			const groupGeometry = await heading.evaluate(element => {
				const label = element.querySelector('.ash-scm-section-label')!.getBoundingClientRect();
				const toolbar = element.querySelector('.ash-scm-section-actions')!.getBoundingClientRect();
				const count = element.querySelector('.ash-scm-section-count')!.getBoundingClientRect();
				return { labelRight: label.right, actionsLeft: toolbar.left, actionsRight: toolbar.right, countLeft: count.left };
			});
			expect(groupGeometry.labelRight).toBeGreaterThan(groupGeometry.actionsLeft);
			expect(groupGeometry.actionsRight).toBeLessThanOrEqual(groupGeometry.countLeft);
			await testInfo.attach(`source-control-${theme}`, { body: await page.locator('#scm-pane').screenshot(), contentType: 'image/png' });
		}
	} finally { await page.evaluate(() => window.gitExtensionIntegration.dispose()); }
});

for (const language of ['en', 'zh-CN']) test(`SCM commit message action handles layout, keyboard, cancellation and repository switching in ${language}`, async ({ page }, testInfo) => {
	const errors = collectErrors(page);
	const generateLabel = language === 'zh-CN' ? '生成提交信息' : 'Generate commit message';
	const stopLabel = language === 'zh-CN' ? '停止生成提交信息' : 'Stop generating commit message';
	await page.goto('/gitExtension.html');
	try {
		await page.evaluate(() => window.gitExtensionIsolation.addGeneric());
		await page.evaluate(language => window.gitExtensionIntegration.activate(language), language);
		await expect.poll(() => page.evaluate(() => window.gitExtensionIntegration.state().repositories[0]?.paths)).toEqual(['one.ts']);
		await page.evaluate(() => window.gitScmPaneIntegration.mount());
		const input = page.locator('#scm-pane .ash-scm-input');
		const button = input.getByRole('button', { name: generateLabel, exact: true });
		await expect(button).toBeVisible();
		await expect(button).toBeDisabled();
		await expect(button).toHaveAttribute('title', language === 'zh-CN' ? '尚未配置提交信息生成器' : 'No commit message generator configured');
		await expect(button.locator('[data-ash-icon-id="sparkle"]')).toHaveCount(1);
		const editor = input.locator('.stanza-editor-input');
		await input.locator('.ash-scm-input-editor').click({ position: { x: 10, y: 10 } });
		await page.keyboard.type('Keep my draft');
		await page.evaluate(() => window.gitScmPaneIntegration.configureGenerator());
		await expect(button).toBeEnabled();
		await page.keyboard.press('Tab');
		await expect(button).toBeFocused();
		const geometry = await input.evaluate(node => {
			const editor = node.querySelector('.ash-scm-input-editor')!.getBoundingClientRect();
			const button = node.querySelector('.ash-scm-input-action')!.getBoundingClientRect();
			const bounds = node.getBoundingClientRect();
			return { separated: editor.right <= button.left, contained: button.right <= bounds.right, width: button.width };
		});
		expect(geometry).toEqual({ separated: true, contained: true, width: 24 });
		for (const theme of ['dark', 'light', 'hcDark', 'hcLight'] as const) {
			await page.evaluate(theme => window.gitScmPaneIntegration.setTheme(theme), theme);
			await expect(button).toHaveCSS('outline-style', 'solid');
			const colors = await button.evaluate(node => {
				const style = getComputedStyle(node);
				const reference = document.createElement('span');
				reference.style.color = style.getPropertyValue('--ash-focusBorder');
				return { color: style.color, focus: style.outlineColor, expectedFocus: reference.style.color };
			});
			expect(colors.color).not.toBe('rgba(0, 0, 0, 0)');
			expect(colors.focus).toBe(colors.expectedFocus);
		}
		await page.evaluate(() => window.gitScmPaneIntegration.setWidth(220));
		await expect(button).toBeFocused();
		await page.keyboard.press('Enter');
		const stop = input.getByRole('button', { name: stopLabel, exact: true });
		await expect(stop).toBeEnabled();
		await expect(stop).toBeFocused();
		await expect(stop.locator('[data-ash-icon-id="stop-circle"]')).toHaveCount(1);
		await expect(input).toHaveAttribute('aria-busy', 'true');
		await page.evaluate(() => window.gitScmPaneIntegration.setClean(false));
		await expect(stop).toBeEnabled();
		await expect.poll(() => page.evaluate(() => window.gitScmPaneIntegration.generationState())).toMatchObject({ count: 1, cancelled: false, groups: [{ id: 'changes', resources: [expect.stringContaining('one.ts')] }] });
		await testInfo.attach(`commit-message-generating-${language}`, { body: await input.screenshot(), contentType: 'image/png' });
		await page.keyboard.press('Space');
		await expect(stop).toBeDisabled();
		expect((await page.evaluate(() => window.gitScmPaneIntegration.generationState())).cancelled).toBe(true);
		await page.evaluate(() => window.gitScmPaneIntegration.finishGeneration());
		await expect(button).toBeEnabled();
		await expect(input).toHaveAttribute('aria-busy', 'false');
		await button.click();
		await expect(stop).toBeEnabled();
		await page.evaluate(() => window.gitScmPaneIntegration.selectRepository('snapshots'));
		expect((await page.evaluate(() => window.gitScmPaneIntegration.generationState())).cancelled).toBe(true);
		await expect(button).toBeDisabled();
		await expect(input).toHaveAttribute('aria-busy', 'false');
		await page.evaluate(() => window.gitScmPaneIntegration.selectRepository('root'));
		expect(await page.evaluate(() => window.gitScmPaneIntegration.draft())).toBe('Keep my draft');
		await page.evaluate(() => window.gitScmPaneIntegration.finishGeneration());
		await button.click();
		await expect(stop).toBeEnabled();
		await page.evaluate(() => window.gitScmPaneIntegration.finishGeneration());
		await expect(button).toBeEnabled();
		await page.evaluate(() => window.gitScmPaneIntegration.setClean(true));
		await expect(button).toBeDisabled();
		await page.evaluate(() => window.gitScmPaneIntegration.setClean(false));
		await button.click();
		await expect(stop).toBeEnabled();
		await page.evaluate(() => window.gitExtensionIntegration.dispose());
		expect((await page.evaluate(() => window.gitScmPaneIntegration.generationState())).cancelled).toBe(true);
		expect(errors).toEqual([]);
	} finally { await page.evaluate(() => window.gitExtensionIntegration.dispose()); }
});

for (const language of ['en', 'zh-CN']) test(`Git rejects an unsupported installation and explains how to upgrade in ${language}`, async ({ page }) => {
	await page.goto('/gitExtension.html');
	try {
		await page.evaluate(async language => {
			window.gitStartupIntegration.setInstallation({ kind: 'unsupported', version: 'git version 2.39.9', minimumVersion: '2.40.0' });
			await window.gitPresentationIntegration.update('git.ignoreMissingGitWarning', true);
			await window.gitExtensionIntegration.activate(language);
		}, language);
		const expected = language === 'zh-CN'
			? 'Ash 需要 Git 2.40.0 或更新版本，当前检测到 git version 2.39.9。请升级 Git 并重启 Ash。如果配置了 git.path，请将它指向升级后的 Git 可执行文件。'
			: 'Ash requires Git 2.40.0 or newer. Found git version 2.39.9. Upgrade Git and restart Ash. If git.path is configured, point it to the upgraded Git executable.';
		await expect.poll(() => page.evaluate(() => window.gitStartupIntegration.installationWarnings())).toEqual([expected]);
		expect(await page.evaluate(() => window.gitExtensionIntegration.state().repositories)).toEqual([]);
		expect(await page.evaluate(() => window.gitExtensionIntegration.state().calls.filter(call => call.method === 'git/repositories' || call.method === 'git/status'))).toEqual([]);
		await page.evaluate(() => window.gitStartupIntegration.refresh());
		expect(await page.evaluate(() => window.gitStartupIntegration.installationWarnings())).toEqual([expected]);
		await page.evaluate(async () => {
			window.gitStartupIntegration.setInstallation({ kind: 'available', version: 'git version 2.40.0' });
			await window.gitPresentationIntegration.update('git.path', '/upgraded/git');
		});
		await expect.poll(() => page.evaluate(() => window.gitExtensionIntegration.state().repositories.map(repository => repository.id))).toEqual(['root']);
	} finally { await page.evaluate(() => window.gitExtensionIntegration.dispose()); }
});

for (const language of ['en', 'zh-CN']) test(`distributed Rust Git registers SCM, commands and history in ${language}`, async ({ page }) => {
	const errors = collectErrors(page);
	await page.goto('/gitExtension.html');
	try {
		const activation = await page.evaluate(language => window.gitExtensionIntegration.activate(language), language);
		expect(activation).toEqual([{ lifecycle: 'ready', failure: undefined, registrations: expect.arrayContaining(['sourceControl', 'command']) }]);
		await expect.poll(() => page.evaluate(() => window.gitExtensionIntegration.state().repositories[0]?.paths)).toEqual(['one.ts']);
		const before = await page.evaluate(() => window.gitExtensionIntegration.state());
		expect(before.repositories[0].groups).toContain(language === 'zh-CN' ? '更改' : 'Changes');
		const history = await page.evaluate(() => window.gitExtensionIntegration.history());
		expect(history).toMatchObject([{ id: 'a'.repeat(40), subject: 'First commit' }]);
		await page.evaluate(() => window.gitExtensionIntegration.invoke('git.switchBranch', ['root']));
		expect((await page.evaluate(() => window.gitExtensionIntegration.state())).errors).toEqual([]);
		expect((await page.evaluate(() => window.gitExtensionIntegration.state())).requests).toContainEqual({ operation: 'showQuickPick', placeholder: language === 'zh-CN' ? '选择 Git 分支' : 'Select a Git branch', items: [{ label: 'main', description: language === 'zh-CN' ? '当前分支' : 'Current', detail: 'a'.repeat(7) }, { label: 'occupied', description: 'origin/occupied', detail: language === 'zh-CN' ? '已在另一个工作树中检出' : 'Checked out in another worktree' }] });
		await page.evaluate(() => window.gitExtensionIntegration.stage());
		await expect.poll(() => page.evaluate(() => window.gitExtensionIntegration.state().calls.some(call => call.method === 'git/stage'))).toBe(true);
		await expect.poll(() => page.evaluate(() => window.gitExtensionIntegration.state().repositories[0]?.groups)).toContain(language === 'zh-CN' ? '暂存的更改' : 'Staged Changes');
		await page.evaluate(async () => {
			window.gitExtensionIntegration.answer(['feature']); await window.gitExtensionIntegration.invoke('git.branch', ['root']);
			window.gitExtensionIntegration.answer(['https://example.com/repo']); await window.gitExtensionIntegration.invoke('git.clone');
			window.gitExtensionIntegration.answer(['main']); await window.gitExtensionIntegration.invoke('git.init');
		});
		expect((await page.evaluate(() => window.gitExtensionIntegration.state())).calls.map(call => call.method)).toEqual(expect.arrayContaining(['git/branch/create', 'git/clone', 'git/init']));
		await page.evaluate(() => window.gitExtensionIntegration.disable());
		expect((await page.evaluate(() => window.gitExtensionIntegration.state())).repositories).toEqual([]);
		expect(errors).toEqual([]); expect((await page.evaluate(() => window.gitExtensionIntegration.state())).errors).toEqual([]);
	} finally { await page.evaluate(() => window.gitExtensionIntegration.dispose()); }
});

for (const language of ['en', 'zh-CN']) test(`disabled Git leaves another SCM Worker and editable diff intact in ${language}`, async ({ page }) => {
	const errors = collectErrors(page);
	await page.goto('/gitExtension.html');
	try {
		await page.evaluate(() => window.gitExtensionIsolation.addGeneric());
		await page.evaluate(language => window.gitExtensionIntegration.activate(language), language);
		await expect.poll(() => page.evaluate(() => window.gitExtensionIntegration.state().repositories.map(value => value.id).sort())).toEqual(['root', 'snapshots']);
		const before = await page.evaluate(() => window.gitExtensionIsolation.runtimes());
		expect(before.every(runtime => runtime.lifecycle === 'ready')).toBe(true);
		await page.evaluate(() => window.gitExtensionIsolation.openEditor());
		await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.type('after');
		await expect.poll(() => page.evaluate(() => window.gitExtensionIsolation.editorState().text)).toBe('before\nafter');
		expect(await page.evaluate(() => window.gitExtensionIsolation.editorState().dirty)).toBe(true);
		await page.evaluate(() => window.gitExtensionIsolation.exerciseProvider());
		await page.evaluate(() => window.gitExtensionIntegration.disable());
		await expect.poll(() => page.evaluate(() => window.gitExtensionIntegration.state().repositories.map(value => value.id))).toEqual(['snapshots']);
		const remaining = await page.evaluate(() => window.gitExtensionIsolation.runtimes());
		expect(remaining).toEqual([before.find(runtime => runtime.id === 'test.snapshots')]);
		expect(await page.evaluate(() => window.gitExtensionIsolation.retiredRequest())).toEqual({ invocationError: expect.stringContaining('retired activation'), backendError: expect.stringContaining('not authorized'), backendCalls: 0 });
		expect(await page.evaluate(() => ['file', 'git-change', 'snapshot'].map(scheme => window.gitExtensionIsolation.openSideVisible(scheme)))).toEqual([false, false, false]);
		expect(await page.evaluate(() => window.gitExtensionIsolation.providerState())).toEqual({ draft: 'retained draft', quickDiff: ['test.snapshots:snapshots'], decorations: 1 });
		expect(await page.evaluate(() => window.gitExtensionIsolation.exerciseProvider())).toEqual({ originals: ['test.snapshots:snapshots'], multi: ['one.ts'] });
		expect(await page.evaluate(() => window.gitExtensionIsolation.accept())).toBe('recorded');
		expect(await page.evaluate(() => window.gitExtensionIsolation.editorState())).toMatchObject({ text: 'before\nafter', dirty: true, savedText: 'before\n' });
		await expect.poll(() => page.evaluate(() => window.gitExtensionIsolation.editorState().diff)).toBe('ready');
		await page.evaluate(() => window.gitExtensionIsolation.undo());
		expect(await page.evaluate(() => window.gitExtensionIsolation.editorState().text)).toBe('before\n');
		await page.evaluate(() => window.gitExtensionIsolation.redo());
		await page.evaluate(() => window.gitExtensionIsolation.save());
		expect(await page.evaluate(() => window.gitExtensionIsolation.editorState())).toMatchObject({ text: 'before\nafter', dirty: false, savedText: 'before\nafter' });
		await page.evaluate(() => window.gitExtensionIsolation.enable());
		await expect.poll(() => page.evaluate(() => window.gitExtensionIntegration.state().repositories.some(value => value.id === 'root'))).toBe(true);
		const restored = await page.evaluate(() => window.gitExtensionIsolation.runtimes());
		expect(restored.find(runtime => runtime.id === 'test.snapshots')).toEqual(remaining[0]);
		expect(restored.find(runtime => runtime.id === 'ash.git')?.incarnation).not.toBe(before.find(runtime => runtime.id === 'ash.git')?.incarnation);
		expect(errors).toEqual([]); expect((await page.evaluate(() => window.gitExtensionIntegration.state())).errors).toEqual([]);
	} finally { await page.evaluate(() => window.gitExtensionIntegration.dispose()); }
});

for (const language of ['en', 'zh-CN']) test(`disabled Git stays inactive after reload while editing works in ${language}`, async ({ page }) => {
	const errors = collectErrors(page);
	await page.goto('/gitExtension.html');
	await page.evaluate(language => window.gitExtensionIntegration.activate(language), language);
	await expect.poll(() => page.evaluate(() => window.gitExtensionIntegration.state().repositories.length)).toBe(1);
	await page.evaluate(() => window.gitExtensionIntegration.disable());
	await page.evaluate(() => window.gitExtensionIntegration.dispose());
	await page.reload();
	try {
		expect(await page.evaluate(language => window.gitExtensionIntegration.activate(language), language)).toEqual([]);
		expect(await page.evaluate(() => window.gitExtensionIntegration.state())).toMatchObject({ repositories: [], calls: [], errors: [] });
		await page.evaluate(() => window.gitExtensionIsolation.openEditor());
		await page.keyboard.press('ControlOrMeta+End'); await page.keyboard.type('saved without Git');
		await page.evaluate(() => window.gitExtensionIsolation.save());
		expect(await page.evaluate(() => window.gitExtensionIsolation.editorState())).toMatchObject({ dirty: false, savedText: 'before\nsaved without Git' });
		await page.evaluate(() => window.gitExtensionIsolation.enable());
		await expect.poll(() => page.evaluate(() => window.gitExtensionIntegration.state().repositories.map(repository => repository.id))).toEqual(['root']);
		expect((await page.evaluate(() => window.gitExtensionIntegration.state())).errors).toEqual([]);
		expect(errors).toEqual([]);
	} finally { await page.evaluate(() => window.gitExtensionIntegration.dispose()); }
});


for (const language of ['en', 'zh-CN']) for (const activation of ['click', 'keyboard'] as const) test(`Git statusbar ${activation} synchronizes through the Rust extension and disables pending actions (${language})`, async ({ page }) => {
	const errors = collectErrors(page);
	await page.goto('/gitExtension.html');
	try {
		await page.emulateMedia({ reducedMotion: 'no-preference' });
		await page.evaluate(async locale => { window.gitStatusbarIntegration.configure(true); await window.gitExtensionIntegration.activate(locale); }, language);
		const sync = page.locator('[data-statusbar-item-id="ash.status.git.sync"] [role="button"]');
		const branch = page.locator('[data-statusbar-item-id="ash.status.git.branch"] [role="button"]');
		const icon = sync.locator('[data-ash-icon-id="sync"]');
		await expect(sync).toHaveText('3↓ 2↑');
		await expect(icon).toHaveCSS('animation-name', 'none');
		if (activation === 'click') await sync.click();
		else { await sync.focus(); await page.keyboard.press('Enter'); }
		await expect(sync).toHaveAttribute('aria-disabled', 'true');
		await expect(branch).toHaveAttribute('aria-disabled', 'true');
		await expect(sync).toHaveAttribute('aria-label', language === 'zh-CN' ? '正在同步更改…' : 'Synchronizing Changes…');
		await expect(icon).toHaveCSS('animation-name', 'ash-statusbar-progress');
		await expect(icon).toHaveCSS('animation-duration', '1.5s');
		await expect(icon).toHaveCSS('animation-timing-function', 'steps(30)');
		await expect(icon).toHaveCSS('transform-origin', '8px 8px');
		const initialCenter = await icon.evaluate(element => {
			const bounds = element.getBoundingClientRect();
			return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
		});
		const initialTransform = await icon.evaluate(element => getComputedStyle(element).transform);
		await expect.poll(() => icon.evaluate(element => getComputedStyle(element).transform)).not.toBe(initialTransform);
		const rotatedCenter = await icon.evaluate(element => {
			const bounds = element.getBoundingClientRect();
			return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
		});
		expect(rotatedCenter.x).toBeCloseTo(initialCenter.x, 2);
		expect(rotatedCenter.y).toBeCloseTo(initialCenter.y, 2);
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await expect(icon).toHaveCSS('animation-name', 'none');
		await page.emulateMedia({ reducedMotion: 'no-preference' });
		await expect(icon).toHaveCSS('animation-name', 'ash-statusbar-progress');
		await sync.click({ force: true });
		await expect.poll(() => page.evaluate(() => window.gitExtensionIntegration.state().calls.filter(call => call.method === 'git/pull').length)).toBe(1);
		expect(await page.evaluate(() => window.gitExtensionIntegration.state().calls.filter(call => call.method === 'git/push'))).toEqual([]);
		await page.evaluate(() => window.gitStatusbarIntegration.release());
		await expect(sync).not.toHaveAttribute('aria-disabled');
		await expect(sync).toHaveText('');
		await expect(icon).toHaveCSS('animation-name', 'none');
		expect(await page.evaluate(() => window.gitExtensionIntegration.state().calls.filter(call => call.method === 'git/pull' || call.method === 'git/push'))).toMatchObject([
			{ method: 'git/pull', params: { repositoryId: 'root', mode: 'sync' } },
			{ method: 'git/push', params: { repositoryId: 'root' } },
		]);
		expect(errors).toEqual([]);
	} finally { await page.evaluate(() => { void window.gitStatusbarIntegration.release(); window.gitExtensionIntegration.dispose(); }); }
});

for (const activation of ['statusbar', 'command'] as const) test(`Git statusbar publishes a branch without upstream through the Rust extension via ${activation}`, async ({ page }) => {
	await page.goto('/gitExtension.html');
	try {
		await page.evaluate(() => window.gitExtensionIntegration.activate('en'));
		const publish = page.locator('[data-statusbar-item-id="ash.status.git.sync"] [role="button"]');
		await expect(publish).toHaveAttribute('aria-label', 'Publish Git branch main');
		if (activation === 'statusbar') await publish.click();
		else await page.evaluate(() => window.gitExtensionIntegration.invoke('git.sync', ['root']));
		await expect.poll(() => page.evaluate(() => window.gitExtensionIntegration.state().calls.filter(call => call.method === 'git/command').map(call => call.params))).toMatchObject([
			{ repositoryId: 'root', command: { kind: 'publishBranch', remote: 'origin', name: 'main', branch: 'main', expectedHead: 'a'.repeat(40) } },
		]);
		await expect(publish).toHaveAttribute('aria-label', /Synchronize Git changes/);
		expect(await page.evaluate(() => window.gitExtensionIntegration.state().errors)).toEqual([]);
	} finally { await page.evaluate(() => window.gitExtensionIntegration.dispose()); }
});

test('Git statusbar does not push after a failed pull through the Rust extension', async ({ page }) => {
	await page.goto('/gitExtension.html');
	try {
		await page.evaluate(async () => { window.gitStatusbarIntegration.configure(true, true); await window.gitExtensionIntegration.activate('en'); });
		const sync = page.locator('[data-statusbar-item-id="ash.status.git.sync"] [role="button"]');
		await expect(sync).toHaveText('3↓ 2↑');
		await sync.click();
		await expect(sync).toHaveAttribute('aria-disabled', 'true');
		await expect(sync.locator('[data-ash-icon-id="sync"]')).toHaveClass(/ash-statusbar-progress/);
		await page.evaluate(() => window.gitStatusbarIntegration.release());
		await expect(sync).not.toHaveAttribute('aria-disabled');
		expect(await page.evaluate(() => window.gitExtensionIntegration.state().calls.filter(call => call.method === 'git/push'))).toEqual([]);
		await expect(sync).toHaveText('3↓ 2↑');
		await expect(sync.locator('[data-ash-icon-id="sync"]')).not.toHaveClass(/ash-statusbar-progress/);
	} finally { await page.evaluate(() => { void window.gitStatusbarIntegration.release(); window.gitExtensionIntegration.dispose(); }); }
});


for (const command of ['git.pullRebase', 'git.syncRebase'] as const) test(`Git statusbar explicit rebase reaches the backend through ${command}`, async ({ page }) => {
	await page.goto('/gitExtension.html');
	try {
		await page.evaluate(async () => { window.gitStatusbarIntegration.configure(true); await window.gitExtensionIntegration.activate('en'); });
		await expect(page.locator('[data-statusbar-item-id="ash.status.git.sync"] [role="button"]')).toHaveText('3↓ 2↑');
		const invocation = page.evaluate(id => window.gitExtensionIntegration.invoke(id, ['root']), command);
		await expect.poll(() => page.evaluate(() => window.gitExtensionIntegration.state().calls.filter(call => call.method === 'git/pull'))).toMatchObject([
			{ method: 'git/pull', params: { repositoryId: 'root', mode: 'rebase', transport: { autoStash: false, followTags: false, prune: false, pullTags: true, pushMode: 'normal', replaceTags: false } } },
		]);
		await page.evaluate(() => window.gitStatusbarIntegration.release());
		await invocation;
		expect(await page.evaluate(() => window.gitExtensionIntegration.state().calls.filter(call => call.method === 'git/push').length)).toBe(command === 'git.syncRebase' ? 1 : 0);
		expect(await page.evaluate(() => window.gitExtensionIntegration.state().errors)).toEqual([]);
	} finally { await page.evaluate(() => { void window.gitStatusbarIntegration.release(); window.gitExtensionIntegration.dispose(); }); }
});

for (const scenario of [
	{ name: 'incoming only', ahead: 0, afterPullAhead: 0, readOnly: false, pushes: 0 },
	{ name: 'pull eliminates outgoing commits', ahead: 2, afterPullAhead: 0, readOnly: false, pushes: 0 },
	{ name: 'pull leaves outgoing commits', ahead: 0, afterPullAhead: 1, readOnly: false, pushes: 1 },
	{ name: 'read-only upstream', ahead: 2, afterPullAhead: 2, readOnly: true, pushes: 0 },
]) test(`Git sync decides whether to push after pull: ${scenario.name}`, async ({ page }) => {
	await page.goto('/gitExtension.html');
	try {
		await page.evaluate(async options => {
			window.gitStatusbarIntegration.configure(true, false, options);
			await window.gitStatusbarIntegration.release();
			await window.gitExtensionIntegration.activate('en');
		}, scenario);
		await page.evaluate(() => window.gitExtensionIntegration.invoke('git.sync', ['root']));
		const state = await page.evaluate(() => window.gitExtensionIntegration.state());
		expect(state.calls.filter(call => call.method === 'git/pull')).toHaveLength(1);
		expect(state.calls.filter(call => call.method === 'git/push')).toHaveLength(scenario.pushes);
		expect(state.requests.filter(request => (request as { method?: string; }).method === 'prompt')).toHaveLength(scenario.readOnly ? 0 : 1);
		expect(state.errors).toEqual([]);
	} finally { await page.evaluate(() => window.gitExtensionIntegration.dispose()); }
});

for (const language of ['en', 'zh-CN']) for (const selection of [0, 1, null]) test(`Git sync confirmation respects ${selection === null ? 'cancel' : selection === 1 ? 'do not show again' : 'OK'} (${language})`, async ({ page }) => {
	await page.goto('/gitExtension.html');
	try {
		await page.evaluate(async ({ language, selection }) => {
			window.gitStatusbarIntegration.configure(true, false, { upstream: 'team/upstream/release' });
			window.gitStatusbarIntegration.setPromptSelection(selection);
			await window.gitStatusbarIntegration.release();
			await window.gitExtensionIntegration.activate(language);
		}, { language, selection });
		await page.evaluate(() => window.gitExtensionIntegration.invoke('git.sync', ['root']));
		const state = await page.evaluate(() => window.gitExtensionIntegration.state());
		const prompts = state.requests.filter(request => (request as { method?: string; }).method === 'prompt');
		expect(prompts).toEqual([{
			method: 'prompt', severity: 'warning',
			message: language === 'zh-CN' ? '此操作将从“team/upstream/release”拉取提交并向其推送提交。' : 'This action will pull and push commits from and to "team/upstream/release".',
			buttons: language === 'zh-CN' ? ['确定', '确定，不再显示'] : ['OK', "OK, Don't Show Again"],
		}]);
		expect(state.calls.filter(call => call.method === 'git/pull')).toHaveLength(selection === null ? 0 : 1);
		if (selection !== null) {
			expect(state.calls.find(call => call.method === 'git/pull')?.params).toMatchObject({ expectedHead: { type: 'branch', name: 'main', upstream: { name: 'team/upstream/release' } } });
			expect(state.calls.find(call => call.method === 'git/push')?.params).toMatchObject({ expectedHead: { type: 'branch', name: 'main', upstream: { name: 'team/upstream/release' } } });
		}
		await expect.poll(() => page.evaluate(() => window.gitStatusbarIntegration.confirmSync())).toBe(selection !== 1);
		if (selection === 1) {
			await page.evaluate(() => window.gitExtensionIntegration.invoke('git.sync', ['root']));
			expect(await page.evaluate(() => window.gitExtensionIntegration.state().requests.filter(request => (request as { method?: string; }).method === 'prompt').length)).toBe(1);
		}
		expect(state.errors).toEqual([]);
	} finally { await page.evaluate(() => window.gitExtensionIntegration.dispose()); }
});

test('Git sync honors disabled confirmation and existing transport settings', async ({ page }) => {
	await page.goto('/gitExtension.html');
	try {
		await page.evaluate(async () => {
			window.gitStatusbarIntegration.configure(true);
			await window.gitStatusbarIntegration.release();
			await window.gitExtensionIntegration.activate('en');
			await window.gitPresentationIntegration.update('git.confirmSync', false);
			await window.gitPresentationIntegration.update('git.fetchOnPull', true);
			await window.gitPresentationIntegration.update('git.pullTags', false);
			await window.gitPresentationIntegration.update('git.followTagsWhenSync', true);
			await window.gitPresentationIntegration.update('git.autoStash', true);
		});
		await page.evaluate(() => window.gitExtensionIntegration.invoke('git.sync', ['root']));
		const state = await page.evaluate(() => window.gitExtensionIntegration.state());
		expect(state.requests.filter(request => (request as { method?: string; }).method === 'prompt')).toEqual([]);
		expect(state.calls.filter(call => ['git/fetch', 'git/pull', 'git/push'].includes(call.method))).toMatchObject([
			{ method: 'git/fetch', params: { transport: { autoStash: true, pullTags: false } } },
			{ method: 'git/pull', params: { mode: 'sync', transport: { autoStash: true, pullTags: false } } },
			{ method: 'git/push', params: { transport: { followTags: true } } },
		]);
		expect(state.errors).toEqual([]);
	} finally { await page.evaluate(() => window.gitExtensionIntegration.dispose()); }
});


for (const command of ['git.pull', 'git.push']) test(`Git sync icon spins during ${command}`, async ({ page }) => {
	await page.goto('/gitExtension.html');
	try {
		await page.evaluate(async () => { window.gitStatusbarIntegration.configure(true); await window.gitExtensionIntegration.activate('en'); });
		const invocation = page.evaluate(command => window.gitExtensionIntegration.invoke(command, ['root']), command);
		const sync = page.locator('[data-statusbar-item-id="ash.status.git.sync"] [role="button"]');
		await expect(sync.locator('[data-ash-icon-id="sync"]')).toHaveClass(/ash-statusbar-progress/);
		await expect(sync).toHaveAttribute('aria-disabled', 'true');
		await page.evaluate(() => window.gitStatusbarIntegration.release()); await invocation;
		await expect(sync.locator('[data-ash-icon-id="sync"]')).not.toHaveClass(/ash-statusbar-progress/);
	} finally { await page.evaluate(() => { void window.gitStatusbarIntegration.release(); window.gitExtensionIntegration.dispose(); }); }
});

test('Git sync waits for confirmation before spinning and prevents duplicate prompts', async ({ page }) => {
	await page.goto('/gitExtension.html');
	try {
		await page.evaluate(async () => { window.gitStatusbarIntegration.configure(true, false, { holdPrompt: true }); await window.gitExtensionIntegration.activate('en'); });
		const sync = page.locator('[data-statusbar-item-id="ash.status.git.sync"] [role="button"]');
		await sync.click();
		await expect.poll(() => page.evaluate(() => window.gitExtensionIntegration.state().requests.filter(request => (request as { method?: string; }).method === 'prompt').length)).toBe(1);
		await expect(sync.locator('[data-ash-icon-id="sync"]')).not.toHaveClass(/ash-statusbar-progress/);
		await sync.click({ force: true });
		expect(await page.evaluate(() => window.gitExtensionIntegration.state().calls.filter(call => call.method === 'git/pull'))).toEqual([]);
		await page.evaluate(() => window.gitStatusbarIntegration.releasePrompt());
		await expect(sync.locator('[data-ash-icon-id="sync"]')).toHaveClass(/ash-statusbar-progress/);
		await page.evaluate(() => window.gitStatusbarIntegration.release());
		await expect(sync).not.toHaveAttribute('aria-disabled');
	} finally { await page.evaluate(() => { void window.gitStatusbarIntegration.releasePrompt(); void window.gitStatusbarIntegration.release(); window.gitExtensionIntegration.dispose(); }); }
});

for (const selection of [0, 1, null]) test(`Git sync rewritten history warning choice ${selection}`, async ({ page }) => {
	await page.goto('/gitExtension.html');
	try {
		await page.evaluate(async selection => {
			window.gitStatusbarIntegration.configure(true, false, { rewritten: true });
			window.gitStatusbarIntegration.setPromptSelection(selection);
			await window.gitStatusbarIntegration.release(); await window.gitExtensionIntegration.activate('en');
			await window.gitPresentationIntegration.update('git.confirmSync', false);
			await window.gitPresentationIntegration.update('git.fetchOnPull', true);
		}, selection);
		await page.evaluate(() => window.gitExtensionIntegration.invoke('git.sync', ['root']));
		const state = await page.evaluate(() => window.gitExtensionIntegration.state());
		expect(state.calls.filter(call => ['git/fetch', 'git/pullPreflight', 'git/pull'].includes(call.method)).map(call => call.method)).toEqual(selection === null ? ['git/fetch', 'git/pullPreflight'] : ['git/fetch', 'git/pullPreflight', 'git/pull']);
		expect(state.requests.filter(request => (request as { method?: string; }).method === 'prompt')).toMatchObject([{ buttons: ['Always Pull', 'Pull'] }]);
		await expect.poll(() => page.evaluate(() => window.gitStatusbarIntegration.setting('git.ignoreRebaseWarning'))).toBe(selection === 0);
	} finally { await page.evaluate(() => window.gitExtensionIntegration.dispose()); }
});

for (const selection of [0, 1, null]) test(`Git sync tag conflict warning choice ${selection}`, async ({ page }) => {
	await page.goto('/gitExtension.html');
	try {
		await page.evaluate(async selection => {
			window.gitStatusbarIntegration.configure(true, false, { tagConflict: true }); window.gitStatusbarIntegration.setPromptSelection(selection);
			await window.gitStatusbarIntegration.release(); await window.gitExtensionIntegration.activate('en');
			await window.gitPresentationIntegration.update('git.confirmSync', false);
		}, selection);
		await page.evaluate(() => window.gitExtensionIntegration.invoke('git.sync', ['root']));
		const state = await page.evaluate(() => window.gitExtensionIntegration.state());
		expect(state.calls.filter(call => call.method === 'git/pull')).toHaveLength(selection === null ? 1 : 2);
		expect(state.calls.filter(call => call.method === 'git/push')).toHaveLength(selection === null ? 0 : 1);
		expect(state.requests.filter(request => (request as { method?: string; }).method === 'prompt')).toMatchObject([{ severity: 'error', buttons: ['Replace Local Tags', 'Always Replace Local Tags'] }]);
		await expect.poll(() => page.evaluate(() => window.gitStatusbarIntegration.setting('git.replaceTagsWhenPull'))).toBe(selection === 1);
	} finally { await page.evaluate(() => window.gitExtensionIntegration.dispose()); }
});

test('Git sync respects enabled warning and tag replacement settings without prompting', async ({ page }) => {
	await page.goto('/gitExtension.html');
	try {
		await page.evaluate(async () => {
			window.gitStatusbarIntegration.configure(true, false, { rewritten: true, tagConflict: true }); await window.gitStatusbarIntegration.release(); await window.gitExtensionIntegration.activate('en');
			for (const [key, value] of [['git.confirmSync', false], ['git.ignoreRebaseWarning', true], ['git.replaceTagsWhenPull', true]] as const) await window.gitPresentationIntegration.update(key, value);
		});
		await page.evaluate(() => window.gitExtensionIntegration.invoke('git.sync', ['root']));
		const state = await page.evaluate(() => window.gitExtensionIntegration.state());
		expect(state.requests.filter(request => (request as { method?: string; }).method === 'prompt')).toEqual([]);
		expect(state.calls.filter(call => call.method === 'git/pullPreflight')).toEqual([]);
		expect(state.calls.filter(call => call.method === 'git/push')).toHaveLength(1);
	} finally { await page.evaluate(() => window.gitExtensionIntegration.dispose()); }
});

test('Git sync hides publishing without remotes and respects the statusbar setting', async ({ page }) => {
	await page.goto('/gitExtension.html');
	try {
		await page.evaluate(async () => { window.gitStatusbarIntegration.configure(false, false, { remotes: [] }); await window.gitStatusbarIntegration.release(); await window.gitExtensionIntegration.activate('en'); });
		await expect(page.locator('[data-statusbar-item-id="ash.status.git.sync"]')).toHaveCount(0);
		await page.evaluate(async () => { window.gitStatusbarIntegration.configure(true); await window.gitStatusbarIntegration.release(); await window.gitExtensionIntegration.invoke('git.refresh', ['root']); });
		await expect(page.locator('[data-statusbar-item-id="ash.status.git.sync"]')).toHaveCount(1);
		await page.evaluate(() => window.gitPresentationIntegration.update('git.enableStatusBarSync', false));
		await expect(page.locator('[data-statusbar-item-id="ash.status.git.sync"]')).toHaveCount(0);
	} finally { await page.evaluate(() => window.gitExtensionIntegration.dispose()); }
});

test('Git sync read-only counts show incoming commits only', async ({ page }) => {
	await page.goto('/gitExtension.html');
	try {
		await page.evaluate(async () => { window.gitStatusbarIntegration.configure(true, false, { readOnly: true }); await window.gitExtensionIntegration.activate('en'); });
		await expect(page.locator('[data-statusbar-item-id="ash.status.git.sync"] [role="button"]')).toHaveText('3↓');
	} finally { await page.evaluate(() => { void window.gitStatusbarIntegration.release(); window.gitExtensionIntegration.dispose(); }); }
});

test('Git sync publish picker can add a remote before publishing', async ({ page }) => {
	await page.goto('/gitExtension.html');
	try {
		await page.evaluate(async () => {
			window.gitStatusbarIntegration.configure(false, false, { remotes: ['origin', 'backup'] });
			window.gitStatusbarIntegration.setRemoteSelection(2);
			window.gitExtensionIntegration.answer(['review', 'https://example.invalid/review.git']);
			await window.gitExtensionIntegration.activate('en');
		});
		await page.locator('[data-statusbar-item-id="ash.status.git.sync"] [role="button"]').click();
		await expect.poll(() => page.evaluate(() => window.gitExtensionIntegration.state().calls.filter(call => call.method === 'git/command').map(call => call.params))).toMatchObject([
			{ command: { kind: 'addRemote', name: 'review', url: 'https://example.invalid/review.git' } },
			{ command: { kind: 'publishBranch', remote: 'review', branch: 'main' } },
		]);
	} finally { await page.evaluate(() => window.gitExtensionIntegration.dispose()); }
});

test('Git sync cancellation honors supportCancellation even when progress is hidden', async ({ page }) => {
	await page.goto('/gitExtension.html');
	try {
		await page.evaluate(async () => {
			window.gitStatusbarIntegration.configure(true); await window.gitExtensionIntegration.activate('en');
			await window.gitPresentationIntegration.update('git.supportCancellation', true);
			await window.gitPresentationIntegration.update('git.showProgress', false);
		});
		const sync = page.locator('[data-statusbar-item-id="ash.status.git.sync"] [role="button"]'); await sync.click();
		await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
		expect(await page.evaluate(() => window.gitStatusbarIntegration.progress().filter(request => request.progress !== null))).toMatchObject([{ method: 'runTransport', progress: { cancellable: true, title: 'Syncing. Cancelling may cause serious damage to the repository.' } }]);
		await page.getByRole('button', { name: 'Cancel', exact: true }).click();
		await expect(sync).not.toHaveAttribute('aria-disabled');
		expect(await page.evaluate(() => window.gitExtensionIntegration.state().calls.filter(call => call.method === 'git/push'))).toEqual([]);
		expect(await page.evaluate(() => window.gitExtensionIntegration.state().errors)).toEqual([]);
	} finally { await page.evaluate(() => { void window.gitStatusbarIntegration.release(); window.gitExtensionIntegration.dispose(); }); }
});

test('Git sync keeps spinning with progress disabled and does not offer push cancellation', async ({ page }) => {
	await page.goto('/gitExtension.html');
	try {
		await page.evaluate(async () => { window.gitStatusbarIntegration.configure(true); await window.gitExtensionIntegration.activate('en'); await window.gitPresentationIntegration.update('git.showProgress', false); });
		const sync = page.locator('[data-statusbar-item-id="ash.status.git.sync"] [role="button"]'); await sync.click();
		await expect(sync.locator('[data-ash-icon-id="sync"]')).toHaveClass(/ash-statusbar-progress/);
		expect(await page.evaluate(() => window.gitStatusbarIntegration.progress().filter(request => request.progress !== null))).toEqual([]);
		await page.evaluate(() => window.gitStatusbarIntegration.release()); await expect(sync).not.toHaveAttribute('aria-disabled');
		await page.evaluate(async () => { window.gitStatusbarIntegration.configure(true); await window.gitPresentationIntegration.update('git.supportCancellation', true); });
		const push = page.evaluate(() => window.gitExtensionIntegration.invoke('git.push', ['root']));
		await expect(sync.locator('[data-ash-icon-id="sync"]')).toHaveClass(/ash-statusbar-progress/);
		expect(await page.evaluate(() => window.gitStatusbarIntegration.progress().filter(request => request.progress !== null))).toEqual([]);
		await page.evaluate(() => window.gitStatusbarIntegration.release()); await push;
	} finally { await page.evaluate(() => { void window.gitStatusbarIntegration.release(); window.gitExtensionIntegration.dispose(); }); }
});

test('Git rebase command labels are localized in Chinese', async ({ page }) => {
	await page.goto('/gitExtension.html');
	try {
		await page.evaluate(() => window.gitExtensionIntegration.activate('zh-CN'));
		const labels = await page.evaluate(() => window.gitStatusbarIntegration.commandLabels());
		expect(labels.filter(command => command.id === 'git.pullRebase' || command.id === 'git.syncRebase').sort((left, right) => left.id.localeCompare(right.id))).toEqual([
			{ id: 'git.pullRebase', title: '拉取（变基）' },
			{ id: 'git.syncRebase', title: '同步更改（变基）' },
		]);
	} finally { await page.evaluate(() => window.gitExtensionIntegration.dispose()); }
});


for (const language of ['en', 'zh-CN']) test(`Git rebase setting reads and writes the shared profile through Settings UI in ${language}`, async ({ page }, testInfo) => {
	await page.goto('/gitExtension.html');
	try {
		await page.evaluate(async lang => { await window.gitExtensionIntegration.activate(lang); window.gitSettingsIntegration.mount(lang); }, language);
		const label = language === 'zh-CN' ? '同步时变基' : 'Rebase When Sync';
		const toggle = page.getByRole('switch', { name: label, exact: true });
		await expect(toggle).toHaveAttribute('aria-checked', 'false');
		await toggle.focus();
		await page.keyboard.press('Space');
		await expect(toggle).toHaveAttribute('aria-checked', 'true');
		await expect.poll(() => page.evaluate(() => window.gitSettingsIntegration.profile())).toEqual({ autofetch: 'off', autofetchPeriod: 180, rebaseWhenSync: true });
		await expect(toggle).toBeEnabled();
		await page.evaluate(() => window.gitSettingsIntegration.externalChange(false));
		await expect(toggle).toHaveAttribute('aria-checked', 'false');
		await page.locator('#git-settings .ash-switch-track').click();
		await expect.poll(() => page.evaluate(() => window.gitSettingsIntegration.profile().rebaseWhenSync)).toBe(true);
		await expect(toggle).toHaveAttribute('aria-checked', 'true');
		await expect(toggle).toBeEnabled();
		await page.locator('#git-settings .ash-setting-item-actions-trigger').click();
		await page.evaluate(() => window.gitSettingsIntegration.reset());
		await expect(toggle).toHaveAttribute('aria-checked', 'false');
		await expect.poll(() => page.evaluate(() => window.gitSettingsIntegration.profile())).toEqual({ autofetch: 'off', autofetchPeriod: 180, rebaseWhenSync: false });
		expect(await page.evaluate(() => window.gitExtensionIntegration.state().errors)).toEqual([]);
		await testInfo.attach(`git-rebase-setting-${language}`, { body: await page.locator('#git-settings').screenshot(), contentType: 'image/png' });
	} finally { await page.evaluate(() => window.gitExtensionIntegration.dispose()); }
});

test('Git rebase Settings UI keeps the saved value when writing fails', async ({ page }) => {
	await page.goto('/gitExtension.html');
	try {
		await page.evaluate(async () => { await window.gitExtensionIntegration.activate('en'); window.gitSettingsIntegration.mount(); });
		const toggle = page.getByRole('switch', { name: 'Rebase When Sync', exact: true });
		await expect(toggle).toHaveAttribute('aria-checked', 'false');
		await page.evaluate(() => window.gitSettingsIntegration.rejectWrites());
		await page.locator('#git-settings .ash-switch-track').click();
		await expect.poll(() => page.evaluate(() => window.gitExtensionIntegration.state().errors.some(error => error.includes('Settings save rejected')))).toBe(true);
		await expect(toggle).toHaveAttribute('aria-checked', 'false');
		expect(await page.evaluate(() => window.gitSettingsIntegration.profile().rebaseWhenSync)).toBe(false);
	} finally { await page.evaluate(() => window.gitExtensionIntegration.dispose()); }
});


test('Git rebase setting command rejects non-boolean input before saving', async ({ page }) => {
	await page.goto('/gitExtension.html');
	try {
		await page.evaluate(() => window.gitExtensionIntegration.activate('zh-CN'));
		const error = await page.evaluate(async () => { try { await window.gitExtensionIntegration.invoke('git.updateRebaseWhenSync', ['true']); return ''; } catch (error) { return String(error); } });
		expect(await page.evaluate(() => window.gitSettingsIntegration.profile().rebaseWhenSync)).toBe(false);
		expect(await page.evaluate(() => window.gitExtensionIntegration.state().calls.filter(call => call.method === 'config/update'))).toEqual([]);
		expect(error).toContain('布尔值');
	} finally { await page.evaluate(() => window.gitExtensionIntegration.dispose()); }
});

test('Git initialization recovers after a transient quota failure without claiming the repository is absent', async ({ page }) => {
	await page.goto('/gitExtension.html');
	try {
		await page.evaluate(() => {
			window.gitStartupIntegration.failInitialization(1);
			window.gitStartupIntegration.mountWelcome('en');
		});
		await page.evaluate(() => window.gitExtensionIntegration.activate('en'));
		await expect(page.locator('#scm-pane')).toContainText('Scanning for Git repositories');
		await expect(page.getByRole('button', { name: 'Initialize Repository', exact: true })).toHaveCount(0);
		await expect(page.locator('#scm-pane .ash-scm-commit-form')).toBeVisible();
		await expect(page.locator('#scm-pane')).not.toContainText('does not contain a Git repository');
		expect(await page.evaluate(() => window.gitExtensionIntegration.state().repositories[0]?.paths)).toEqual(['one.ts']);
	} finally { await page.evaluate(() => window.gitExtensionIntegration.dispose()); }
});

test('Git detection failure offers a Chinese keyboard retry and restores the real provider', async ({ page }) => {
	await page.goto('/gitExtension.html');
	try {
		await page.evaluate(() => {
			window.gitStartupIntegration.failInitialization(3);
			window.gitStartupIntegration.mountWelcome('zh-cn');
		});
		await page.evaluate(() => window.gitExtensionIntegration.activate('zh-cn'));
		await expect(page.locator('#scm-pane')).toContainText('Git 仓库检测失败');
		await expect(page.getByRole('button', { name: '初始化仓库', exact: true })).toHaveCount(0);
		const retry = page.getByRole('button', { name: '重试仓库检测', exact: true });
		await retry.focus();
		await page.keyboard.press('Enter');
		await expect(page.locator('#scm-pane .ash-scm-commit-form')).toBeVisible();
		await expect(retry).toHaveCount(0);
		expect(await page.evaluate(() => window.gitExtensionIntegration.state().repositories[0]?.paths)).toEqual(['one.ts']);
	} finally { await page.evaluate(() => window.gitExtensionIntegration.dispose()); }
});
