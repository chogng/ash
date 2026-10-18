import { expect, test } from '@playwright/test';

test('application tools adapt file, review and browser resources into window services', async ({ page }) => {
	await page.goto('/appTools.html');
	await expect.poll(() => page.evaluate(() => !!window.ashAppToolsIntegration)).toBe(true);
	expect(await page.evaluate(() => window.ashAppToolsIntegration.call({ type: 'openFile', path: '/workspace/a b.ts', line: 12 }))).toEqual({ opened: true, path: '/workspace/a b.ts' });
	expect(await page.evaluate(() => window.ashAppToolsIntegration.call({ type: 'openReview', original: '/workspace/before.ts', modified: '/workspace/after.ts' }))).toEqual({ opened: true });
	expect(await page.evaluate(() => {
		const [file, options] = window.ashAppToolsIntegration.opened[0] as [{ resource: { scheme: string; path: string; }; }, { selection: { startLineNumber: number; startColumn: number; }; }];
		const [review] = window.ashAppToolsIntegration.opened[1] as [{ original: { resource: { path: string; }; }; modified: { resource: { path: string; }; }; }];
		return { file: [file.resource.scheme, file.resource.path], selection: [options.selection.startLineNumber, options.selection.startColumn], review: [review.original.resource.path, review.modified.resource.path] };
	})).toEqual({ file: ['file', '/workspace/a b.ts'], selection: [12, 1], review: ['/workspace/before.ts', '/workspace/after.ts'] });
	expect(await page.evaluate(() => window.ashAppToolsIntegration.call({ type: 'openBrowser', url: 'https://example.com/review?item=1' }))).toEqual({ opened: true });
	expect(await page.evaluate(() => window.ashAppToolsIntegration.openedUrls)).toEqual(['https://example.com/review?item=1']);
});

test('application tools update the visible sidebar, preserve focus, persist and return explicit failures', async ({ page }) => {
	page.on('pageerror', error => console.error(error.message));
	await page.goto('/appTools.html');
	await expect.poll(() => page.evaluate(() => !!window.ashAppToolsIntegration)).toBe(true);
	const group = await page.evaluate(async () => await window.ashAppToolsIntegration.call({ type: 'createSection', name: '<Review>' }) as { sectionId: string; });
	await expect(page.getByRole('heading', { name: '<Review>', exact: true })).toBeVisible();
	await expect(page.getByRole('heading', { name: '<Review>', exact: true })).toHaveCSS('font-size', '12px');
	await expect(page.getByRole('heading', { name: '<Review>', exact: true })).toHaveCSS('font-weight', '600');
	await page.evaluate(sectionId => window.ashAppToolsIntegration.call({ type: 'moveSession', sessionId: 'session-2', sectionId }), group.sectionId);
	const rows = page.locator('.ash-sessions-list-item');
	await expect(rows).toHaveText(['Task 2', 'Task 1']);
	await rows.first().focus();
	await page.evaluate(sectionId => window.ashAppToolsIntegration.call({ type: 'renameSection', sectionId, name: 'Ship' }), group.sectionId);
	await expect(rows.first()).toBeFocused();
	await expect(page.getByRole('heading', { name: 'Ship', exact: true })).toBeVisible();
	expect(await page.evaluate(async sectionId => {
		try { await window.ashAppToolsIntegration.call({ type: 'reorderSection', sectionId, sessionIds: [] }); return 'accepted'; }
		catch (error) { return String(error); }
	}, group.sectionId)).toContain('exactly once');
	await expect(rows).toHaveText(['Task 2', 'Task 1']);
	await page.reload();
	await expect(page.getByRole('heading', { name: 'Ship', exact: true })).toBeVisible();
	await expect(rows).toHaveText(['Task 2', 'Task 1']);
	await page.evaluate(() => window.ashAppToolsIntegration.call({ type: 'navigate', sessionId: 'session-1', threadId: 'thread-1' }));
	expect(await page.evaluate(() => window.ashAppToolsIntegration.opened)).toEqual([{ sessionId: 'session-1', threadId: 'thread-1' }]);
	await page.evaluate(sectionId => window.ashAppToolsIntegration.call({ type: 'deleteSection', sectionId }), group.sectionId);
	await expect(rows).toHaveText(['Task 1', 'Task 2']);
});

test('application celebration respects reduced motion and localized sidebar controls', async ({ page }) => {
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await page.goto('/appTools.html?locale=zh-CN');
	await expect.poll(() => page.evaluate(() => !!window.ashAppToolsIntegration)).toBe(true);
	expect(await page.evaluate(() => window.ashAppToolsIntegration.call({ type: 'confetti' }))).toEqual({ fired: false });
	await expect(page.getByRole('searchbox')).toHaveAttribute('aria-label', '搜索会话');
	const result = await page.evaluate(async () => {
		try { await window.ashAppToolsIntegration.call({ type: 'checkUpdate' }); return 'accepted'; }
		catch (error) { return String(error); }
	});
	expect(result).toContain('unavailable');
});

test('cancelling an application request preserves the connection and releases a late terminal', async ({ page }) => {
	await page.goto('/appTools.html');
	await expect.poll(() => page.evaluate(() => !!window.ashAppToolsIntegration)).toBe(true);
	const cancelled = page.evaluate(async () => {
		try { await window.ashAppToolsIntegration.call({ type: 'openTerminal' }); return 'accepted'; }
		catch (error) { return String(error); }
	});
	await expect.poll(() => page.evaluate(() => window.ashAppToolsIntegration.terminalPending)).toBe(true);
	await page.evaluate(() => window.ashAppToolsIntegration.cancelLast());
	expect(await cancelled).toContain('cancelled');
	await page.evaluate(() => window.ashAppToolsIntegration.releaseTerminal());
	await expect.poll(() => page.evaluate(() => window.ashAppToolsIntegration.closedTerminals)).toEqual(['terminal-1']);
	expect(await page.evaluate(() => window.ashAppToolsIntegration.call({ type: 'listSections' }))).toEqual({ sections: [] });
});

for (const platform of ['linux', 'osx', 'windows']) {
	test(`Agent terminal resolves agentHost policy on ${platform} through the existing PTY owner`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto(`/appTools.html?os=${platform}`);
		await expect.poll(() => page.evaluate(() => !!window.ashAppToolsIntegration)).toBe(true);
		await page.evaluate(async platform => {
			await window.ashAppToolsIntegration.configureTerminal({
				[`terminal.integrated.profiles.${platform}`]: { Interactive: { path: '/interactive/shell' } },
				[`terminal.integrated.defaultProfile.${platform}`]: 'Interactive',
				[`terminal.integrated.automationProfile.${platform}`]: { path: '/automation/shell' },
				[`terminal.integrated.agentHostProfile.${platform}`]: { path: platform === 'windows' ? 'C:\\tools\\pwsh.exe' : '${env:HOME}/agent/bash', args: ['-l', '${env:BASE}'], env: { MODE: 'agent', PROFILE: '${env:BASE}', REMOVED: null } },
				[`terminal.integrated.env.${platform}`]: { MODE: 'global', GLOBAL: '${env:HOME}', REMOVED: 'global' },
				'terminal.integrated.cwd': '${workspaceFolder}/shell work',
			});
			window.ashAppToolsIntegration.automaticCreation();
		}, platform);
		expect(await page.evaluate(() => window.ashAppToolsIntegration.call({ type: 'openTerminal' }))).toEqual({ opened: true, terminalId: 'terminal-instance-1' });
		expect(await page.evaluate(() => window.ashAppToolsIntegration.profileSelections)).toContainEqual({ type: 'custom', name: 'Agent host shell', path: [platform === 'windows' ? 'C:\\tools\\pwsh.exe' : '/execution/home/agent/bash'], args: ['-l', 'inherited'] });
		expect(await page.evaluate(() => ({ created: window.ashAppToolsIntegration.terminalCreations, active: window.ashAppToolsIntegration.activeTerminal, views: window.ashAppToolsIntegration.terminalViews }))).toEqual({
			created: [{ dirId: 'app-tools', rows: 24, cols: 80, profile: { type: 'custom', name: 'Agent host shell', path: [platform === 'windows' ? 'C:\\tools\\pwsh.exe' : '/execution/home/agent/bash'], args: ['-l', 'inherited'] }, env: { MODE: 'agent', GLOBAL: '/execution/home', REMOVED: null, PROFILE: 'inherited' }, cwd: platform === 'windows' ? 'C:\\workspace/shell work' : '/workspace/shell work' }],
			active: 'terminal-instance-1', views: [{ id: 'ash.terminal', focus: true }],
		});
		expect(errors).toEqual([]);
	});
}

test('an empty Agent profile falls back to the configured interactive shell and Chinese profile identity', async ({ page }) => {
	await page.goto('/appTools.html?locale=zh-CN');
	await expect.poll(() => page.evaluate(() => !!window.ashAppToolsIntegration)).toBe(true);
	await page.evaluate(async () => {
		await window.ashAppToolsIntegration.configureTerminal({
			'terminal.integrated.profiles.linux': { '交互 Shell': { path: '/interactive/fish', args: ['--interactive'], env: { MODE: 'interactive' } } },
			'terminal.integrated.defaultProfile.linux': '交互 Shell',
			'terminal.integrated.automationProfile.linux': { path: '/wrong/automation' },
			'terminal.integrated.agentHostProfile.linux': null,
		});
		window.ashAppToolsIntegration.automaticCreation();
	});
	expect(await page.evaluate(() => window.ashAppToolsIntegration.call({ type: 'openTerminal' }))).toEqual({ opened: true, terminalId: 'terminal-instance-1' });
	expect(await page.evaluate(() => window.ashAppToolsIntegration.terminalCreations[0].profile)).toEqual({ type: 'custom', name: '交互 Shell', path: ['/interactive/fish'], args: ['--interactive'] });
});

for (const invalidation of ['cancel', 'workspace', 'connection', 'dispose'] as const) {
	test(`Agent terminal resolution handles ${invalidation} without creating a PTY or opening its view`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('/appTools.html');
		await expect.poll(() => page.evaluate(() => !!window.ashAppToolsIntegration)).toBe(true);
		await page.evaluate(() => window.ashAppToolsIntegration.holdProfile());
		const pending = page.evaluate(async () => {
			try { await window.ashAppToolsIntegration.call({ type: 'openTerminal' }); return 'accepted'; }
			catch (error) { return String(error); }
		});
		await expect.poll(() => page.evaluate(() => window.ashAppToolsIntegration.profilePending)).toBe(true);
		await page.evaluate(invalidation => {
			if (invalidation === 'cancel') window.ashAppToolsIntegration.cancelLast();
			if (invalidation === 'workspace') window.ashAppToolsIntegration.changeWorkspace();
			if (invalidation === 'connection') window.ashAppToolsIntegration.disconnectTerminal();
			if (invalidation === 'dispose') window.ashAppToolsIntegration.disposeHost();
			window.ashAppToolsIntegration.releaseProfile();
		}, invalidation);
		expect(await pending).toMatch(/cancelled/i);
		expect(await page.evaluate(() => ({ created: window.ashAppToolsIntegration.terminalCreations, views: window.ashAppToolsIntegration.terminalViews }))).toEqual({ created: [], views: [] });
		expect(errors).toEqual([]);
	});
}

for (const invalidation of ['workspace', 'connection'] as const) {
	test(`Agent terminal creation releases its late PTY after ${invalidation} without opening its view`, async ({ page }) => {
		await page.goto('/appTools.html');
		await expect.poll(() => page.evaluate(() => !!window.ashAppToolsIntegration)).toBe(true);
		const pending = page.evaluate(async () => {
			try { await window.ashAppToolsIntegration.call({ type: 'openTerminal' }); return 'accepted'; }
			catch (error) { return String(error); }
		});
		await expect.poll(() => page.evaluate(() => window.ashAppToolsIntegration.terminalPending)).toBe(true);
		await page.evaluate(invalidation => {
			if (invalidation === 'workspace') window.ashAppToolsIntegration.changeWorkspace();
			else window.ashAppToolsIntegration.disconnectTerminal();
			window.ashAppToolsIntegration.releaseTerminal();
		}, invalidation);
		expect(await pending).toMatch(/cancelled/i);
		await expect.poll(() => page.evaluate(() => ({ closed: window.ashAppToolsIntegration.closedTerminals, active: window.ashAppToolsIntegration.activeTerminal, views: window.ashAppToolsIntegration.terminalViews }))).toEqual({ closed: ['terminal-1'], active: undefined, views: [] });
	});
}

test('Agent terminal startup reports resolver failure and an unavailable host without creating a PTY', async ({ page }) => {
	await page.goto('/appTools.html?locale=zh-CN');
	await expect.poll(() => page.evaluate(() => !!window.ashAppToolsIntegration)).toBe(true);
	await page.evaluate(() => window.ashAppToolsIntegration.failProfile());
	expect(await page.evaluate(async () => {
		try { await window.ashAppToolsIntegration.call({ type: 'openTerminal' }); return 'accepted'; }
		catch (error) { return String(error); }
	})).toContain('Profile executable unavailable');
	await page.evaluate(() => window.ashAppToolsIntegration.unavailableHost());
	expect(await page.evaluate(async () => {
		try { await window.ashAppToolsIntegration.call({ type: 'openTerminal' }); return 'accepted'; }
		catch (error) { return String(error); }
	})).toContain('终端执行端尚未就绪');
	expect(await page.evaluate(() => window.ashAppToolsIntegration.terminalCreations)).toEqual([]);
});

test('Agent terminal releases its PTY when the terminal view cannot open', async ({ page }) => {
	await page.goto('/appTools.html');
	await expect.poll(() => page.evaluate(() => !!window.ashAppToolsIntegration)).toBe(true);
	await page.evaluate(() => { window.ashAppToolsIntegration.automaticCreation(); window.ashAppToolsIntegration.failView(); });
	expect(await page.evaluate(async () => {
		try { await window.ashAppToolsIntegration.call({ type: 'openTerminal' }); return 'accepted'; }
		catch (error) { return String(error); }
	})).toContain('Terminal view unavailable');
	expect(await page.evaluate(() => ({ closed: window.ashAppToolsIntegration.closedTerminals, active: window.ashAppToolsIntegration.activeTerminal }))).toEqual({ closed: ['terminal-1'], active: undefined });
});

test('disposing the application adapter releases its host and rejects late terminal completion', async ({ page }) => {
	await page.goto('/appTools.html');
	await expect.poll(() => page.evaluate(() => !!window.ashAppToolsIntegration)).toBe(true);
	expect(await page.evaluate(() => window.ashAppToolsIntegration.call({ type: 'confetti' }))).toEqual({ fired: true });
	await expect(page.locator('.ash-app-confetti')).toHaveCount(1);
	await expect(page.locator('.ash-app-confetti')).toHaveAttribute('aria-hidden', 'true');
	await expect(page.locator('.ash-app-confetti-particle').first()).toHaveCSS('font-size', '13px');
	const pending = page.evaluate(async () => {
		try { await window.ashAppToolsIntegration.call({ type: 'openTerminal' }); return 'accepted'; }
		catch (error) { return String(error); }
	});
	await expect.poll(() => page.evaluate(() => window.ashAppToolsIntegration.terminalPending)).toBe(true);
	await page.evaluate(() => window.ashAppToolsIntegration.disposeHost());
	await expect(page.locator('.ash-app-confetti')).toHaveCount(0);
	await page.evaluate(() => window.ashAppToolsIntegration.releaseTerminal());
	expect(await pending).toContain('cancelled');
	expect(await page.evaluate(() => window.ashAppToolsIntegration.closedTerminals)).toEqual(['terminal-1']);
	expect(await page.evaluate(async () => {
		try { await window.ashAppToolsIntegration.call({ type: 'listSections' }); return 'accepted'; }
		catch (error) { return String(error); }
	})).toBe('Error: Method not found');
});

test('sidebar headings and celebration particles resolve typography in every theme', async ({ page }) => {
	await page.emulateMedia({ reducedMotion: 'no-preference' });
	for (const theme of ['light', 'dark', 'hcLight', 'hcDark']) {
		await page.goto(`/appTools.html?theme=${theme}`);
		await expect.poll(() => page.evaluate(() => !!window.ashAppToolsIntegration)).toBe(true);
		const name = `Review ${theme}`;
		await page.evaluate(name => window.ashAppToolsIntegration.call({ type: 'createSection', name }), name);
		const heading = page.getByRole('heading', { name, exact: true });
		await expect(heading).toHaveCSS('font-size', '12px');
		await expect(heading).toHaveCSS('font-weight', '600');
		expect(await page.evaluate(() => window.ashAppToolsIntegration.call({ type: 'confetti' }))).toEqual({ fired: true });
		await expect(page.locator('.ash-app-confetti-particle').first()).toHaveCSS('font-size', '13px');
		await page.evaluate(() => window.ashAppToolsIntegration.disposeHost());
		await expect(page.locator('.ash-app-confetti')).toHaveCount(0);
	}
});

for (const locale of ['en', 'zh-CN']) {
	test(`Agent task tools share Run IDs, output and cancellation with Tasks and Terminal in ${locale}`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('/appTools.html?taskTools=true&locale=' + locale);
		await expect.poll(() => page.evaluate(() => !!window.ashAppToolsIntegration)).toBe(true);
		await page.evaluate(() => window.ashAppToolsIntegration.automaticCreation());
		const catalog = await page.evaluate(async () => await window.ashAppToolsIntegration.call({ type: 'tasksList', directory: '/workspace' }) as import('../../../src/ash/sessions/services/appTools/browser/appTools.js').TaskCatalog);
		const task = catalog.tasks.find(task => task.label === 'Check')!;
		expect(task.revision).toHaveLength(64);
		expect(catalog.tasks.find(task => task.label === 'Interactive')!.unavailableReason).toContain(locale === 'zh-CN' ? '需要扩展' : 'needs an extension');
		const taskButton = page.getByRole('button', { name: 'Editor focus target' });
		await taskButton.focus();
		const run = await page.evaluate(async task => await window.ashAppToolsIntegration.call({ type: 'tasksRun', directory: '/workspace', taskId: task.taskId, revision: task.revision! }) as import('../../../src/ash/sessions/services/appTools/browser/appTools.js').TaskRunSummary, task);
		const status = () => page.evaluate(async runId => await window.ashAppToolsIntegration.call({ type: 'tasksStatus', directory: '/workspace', runId }) as import('../../../src/ash/sessions/services/appTools/browser/appTools.js').TaskRunSummary, run.runId);
		await expect.poll(async () => (await status()).terminalId).toBe('terminal-instance-1');
		await expect.poll(() => page.evaluate(runId => window.ashAppToolsIntegration.taskRuns.find(run => run.runId === runId), run.runId)).toMatchObject({ runId: run.runId, terminalId: 'terminal-instance-1', label: 'Check', status: 'running' });
		await expect(taskButton).toBeFocused();
		await expect.poll(() => page.evaluate(async runId => (await window.ashAppToolsIntegration.call({ type: 'tasksOutput', directory: '/workspace', runId, cursor: 0, maxCharacters: 4096 }) as { text: string; }).text, run.runId)).toContain('output for terminal-1');
		expect(await page.evaluate(() => window.ashAppToolsIntegration.terminalCreations.length)).toBe(1);
		for (let attempt = 0; attempt < 2; attempt++) {
			const cancelled = await page.evaluate(async runId => await window.ashAppToolsIntegration.call({ type: 'tasksCancel', directory: '/workspace', runId }) as { status: string; }, run.runId);
			expect(cancelled.status).toBe('canceled');
			await expect.poll(() => page.evaluate(runId => window.ashAppToolsIntegration.taskRuns.find(run => run.runId === runId)?.status, run.runId)).toBe('canceled');
		}
		expect((await status()).status).toBe('canceled');
		await expect(taskButton).toBeFocused();

		expect(await page.evaluate(() => window.ashAppToolsIntegration.closedTerminals)).toEqual(['terminal-1']);
		await page.evaluate(() => window.ashAppToolsIntegration.changeTask());
		const stale = await page.evaluate(async task => { try { await window.ashAppToolsIntegration.call({ type: 'tasksRun', directory: '/workspace', taskId: task.taskId, revision: task.revision! }); return 'unexpected success'; } catch (error) { return String(error); } }, task);
		expect(stale).toContain(locale === 'zh-CN' ? '已更改' : 'configuration changed');
		expect(await page.evaluate(() => window.ashAppToolsIntegration.terminalCreations.length)).toBe(1);
		expect(errors).toEqual([]);
	});
}


test('a dependency failure leaves the returned root Run ID visible and preserves keyboard focus', async ({ page }) => {
	await page.goto('/appTools.html?taskTools=true');
	await expect.poll(() => page.evaluate(() => !!window.ashAppToolsIntegration)).toBe(true);
	await page.evaluate(async () => {
		window.ashAppToolsIntegration.automaticCreation();
		await window.ashAppToolsIntegration.configureTasks([{ label: 'Prepare', command: 'prepare', presentation: { reveal: 'never' } }, { label: 'Root', command: 'root', dependsOn: 'Prepare', presentation: { reveal: 'never' } }]);
	});
	const button = page.getByRole('button', { name: 'Editor focus target' });
	await button.focus();
	const runId = await page.evaluate(async () => {
		const catalog = await window.ashAppToolsIntegration.call({ type: 'tasksList', directory: '/workspace' }) as import('../../../src/ash/sessions/services/appTools/browser/appTools.js').TaskCatalog;
		const task = catalog.tasks.find(task => task.label === 'Root')!;
		return (await window.ashAppToolsIntegration.call({ type: 'tasksRun', directory: '/workspace', taskId: task.taskId, revision: task.revision! }) as { runId: string; }).runId;
	});
	await expect.poll(() => page.evaluate(() => window.ashAppToolsIntegration.terminalCreations.length)).toBe(1);
	await page.evaluate(() => window.ashAppToolsIntegration.finishTask(1));
	await expect.poll(() => page.evaluate(runId => window.ashAppToolsIntegration.taskRuns.find(run => run.runId === runId)?.status, runId)).toBe('failed');
	await expect(button).toBeFocused();
	expect(await page.evaluate(async runId => (await window.ashAppToolsIntegration.call({ type: 'tasksOutput', directory: '/workspace', runId, cursor: 0, maxCharacters: 4096 }) as { text: string; }).text, runId)).toContain("Dependency 'Prepare'");
});

test('disconnecting the application connection cancels its Agent run and preserves a manual run', async ({ page }) => {
	await page.goto('/appTools.html?taskTools=true');
	await expect.poll(() => page.evaluate(() => !!window.ashAppToolsIntegration)).toBe(true);
	const manual = await page.evaluate(async () => {
		window.ashAppToolsIntegration.automaticCreation();
		await window.ashAppToolsIntegration.configureTasks([{ label: 'Manual', command: 'manual', presentation: { reveal: 'never' } }, { label: 'Check', command: 'check', presentation: { reveal: 'never' } }]);
		return window.ashAppToolsIntegration.runManualTask('Manual');
	});
	const agent = await page.evaluate(async () => {
		const catalog = await window.ashAppToolsIntegration.call({ type: 'tasksList', directory: '/workspace' }) as import('../../../src/ash/sessions/services/appTools/browser/appTools.js').TaskCatalog;
		const task = catalog.tasks.find(task => task.label === 'Check')!;
		return (await window.ashAppToolsIntegration.call({ type: 'tasksRun', directory: '/workspace', taskId: task.taskId, revision: task.revision! }) as { runId: string; }).runId;
	});
	await expect.poll(() => page.evaluate(() => window.ashAppToolsIntegration.terminalCreations.length)).toBe(2);
	await expect.poll(() => page.evaluate(runId => window.ashAppToolsIntegration.taskRuns.find(run => run.runId === runId)?.terminalId, agent)).toBe('terminal-instance-2');
	await page.evaluate(() => window.ashAppToolsIntegration.disconnectAppServer());
	await expect.poll(() => page.evaluate(() => window.ashAppToolsIntegration.closedTerminals)).toEqual(['terminal-2']);
	await expect.poll(() => page.evaluate(() => window.ashAppToolsIntegration.taskRuns.map(({ runId, status }) => ({ runId, status })))).toEqual([{ runId: manual, status: 'running' }, { runId: agent, status: 'canceled' }]);
});

test('joining a manual run does not transfer disconnect cancellation ownership to the Agent', async ({ page }) => {
	await page.goto('/appTools.html?taskTools=true');
	await expect.poll(() => page.evaluate(() => !!window.ashAppToolsIntegration)).toBe(true);
	const manual = await page.evaluate(async () => {
		window.ashAppToolsIntegration.automaticCreation();
		await window.ashAppToolsIntegration.configureTasks([{ label: 'Check', command: 'check', runOptions: { instancePolicy: 'silent' }, presentation: { reveal: 'never' } }]);
		return window.ashAppToolsIntegration.runManualTask('Check');
	});
	const agent = await page.evaluate(async () => {
		const catalog = await window.ashAppToolsIntegration.call({ type: 'tasksList', directory: '/workspace' }) as import('../../../src/ash/sessions/services/appTools/browser/appTools.js').TaskCatalog;
		const task = catalog.tasks[0]!;
		return (await window.ashAppToolsIntegration.call({ type: 'tasksRun', directory: '/workspace', taskId: task.taskId, revision: task.revision! }) as { runId: string; }).runId;
	});
	expect(agent).toBe(manual);
	await page.evaluate(() => window.ashAppToolsIntegration.disconnectAppServer());
	expect(await page.evaluate(() => ({ runs: window.ashAppToolsIntegration.taskRuns.map(({ runId, status }) => ({ runId, status })), closed: window.ashAppToolsIntegration.closedTerminals, created: window.ashAppToolsIntegration.terminalCreations.length }))).toEqual({ runs: [{ runId: manual, status: 'running' }], closed: [], created: 1 });
});

for (const invalidation of ['disconnect', 'dispose', 'concurrent cancel'] as const) {
	test(`a preparing Agent task releases its late PTY exactly once after ${invalidation}`, async ({ page }) => {
		await page.goto('/appTools.html?taskTools=true');
		await expect.poll(() => page.evaluate(() => !!window.ashAppToolsIntegration)).toBe(true);
		const runId = await page.evaluate(async () => {
			const catalog = await window.ashAppToolsIntegration.call({ type: 'tasksList', directory: '/workspace' }) as import('../../../src/ash/sessions/services/appTools/browser/appTools.js').TaskCatalog;
			const task = catalog.tasks.find(task => task.label === 'Check')!;
			return (await window.ashAppToolsIntegration.call({ type: 'tasksRun', directory: '/workspace', taskId: task.taskId, revision: task.revision! }) as { runId: string; }).runId;
		});
		await expect.poll(() => page.evaluate(() => window.ashAppToolsIntegration.terminalPending)).toBe(true);
		const cancellation = page.evaluate(async ({ invalidation, runId }) => {
			if (invalidation === 'disconnect') window.ashAppToolsIntegration.disconnectAppServer();
			else if (invalidation === 'dispose') window.ashAppToolsIntegration.disposeHost();
			else {
				return Promise.all([1, 2].map(async () => await window.ashAppToolsIntegration.call({ type: 'tasksCancel', directory: '/workspace', runId }) as { status: string; }));
			}
			return undefined;
		}, { invalidation, runId });
		// Both inbound cancellations must be dispatched before the late handle is released.
		if (invalidation === 'concurrent cancel') await expect.poll(() => page.evaluate(() => window.ashAppToolsIntegration.taskCancelRequests)).toBe(2);
		else await cancellation;
		await page.evaluate(() => window.ashAppToolsIntegration.releaseTerminal());
		if (invalidation === 'concurrent cancel') expect(await cancellation).toEqual([expect.objectContaining({ status: 'canceled' }), expect.objectContaining({ status: 'canceled' })]);
		await expect.poll(() => page.evaluate(() => window.ashAppToolsIntegration.closedTerminals)).toEqual(['terminal-1']);
		await expect.poll(() => page.evaluate(() => window.ashAppToolsIntegration.taskRuns.map(({ runId, status }) => ({ runId, status })))).toEqual([{ runId, status: 'canceled' }]);
	});
}
