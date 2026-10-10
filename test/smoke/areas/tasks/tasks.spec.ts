import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { basename, join, sep } from 'node:path';
import { expect, test } from '../../../automation/test.js';

test.beforeEach(async ({ target, testWorkspace }) => {
	test.skip(target.appServerMode !== 'required', 'Requires workspace tasks and terminal execution.');
	await mkdir(join(testWorkspace.directory, '.vscode'));
	await writeFile(join(testWorkspace.directory, '.vscode', 'tasks.json'), JSON.stringify({
		version: '2.0.0', tasks: [
			{ label: 'Smoke build', type: 'shell', command: 'node smoke-task.cjs', group: 'build' },
			{ label: 'Smoke environment', type: 'shell', command: 'node smoke-env.cjs "${env:TERM_PROGRAM}" "${env:ASH_MISSING_VALUE}"', options: { env: { ASH_TASK_VALUE: 'task value', ASH_TASK_FOLDER: '${workspaceFolder}', 'ASH_TASK_${env:TERM_PROGRAM}': 'resolved key', TERM_PROGRAM: null } } },
			{ label: 'Smoke watch', type: 'shell', command: 'node smoke-watch.cjs' },
		]
	}));
	await writeFile(join(testWorkspace.directory, 'task-runs.txt'), '0');
	await writeFile(join(testWorkspace.directory, 'smoke-task.cjs'), "const fs = require('node:fs'); const count = Number(fs.readFileSync('task-runs.txt', 'utf8')) + 1; fs.writeFileSync('task-runs.txt', String(count)); console.log('ASH_TASK_RUN_' + count);\n");
	await writeFile(join(testWorkspace.directory, 'smoke-env.cjs'), "require('node:fs').writeFileSync('task-environment.json', JSON.stringify({ args: process.argv.slice(2), value: process.env.ASH_TASK_VALUE, folder: process.env.ASH_TASK_FOLDER, keyed: process.env['ASH_TASK_' + process.argv[2]], removed: process.env.TERM_PROGRAM === undefined }));\n");
	await writeFile(join(testWorkspace.directory, 'smoke-watch.cjs'), "console.log('ASH_TASK_WATCH_READY'); setInterval(() => {}, 1000);\n");
});

test('task discovery does not execute commands and explicit run and rerun use the workspace terminal', async ({ workbench, testWorkspace }) => {
	await workbench.quickaccess.runCommand('workbench.action.tasks.runTask');
	await expect(workbench.quickaccess.items.filter({ hasText: 'Smoke build' })).toBeVisible();
	expect(await readFile(join(testWorkspace.directory, 'task-runs.txt'), 'utf8')).toBe('0');
	await workbench.quickaccess.select('Smoke build');
	await expect.poll(() => readFile(join(testWorkspace.directory, 'task-runs.txt'), 'utf8')).toBe('1');
	await expect(workbench.terminal.activeInstance).toContainText('ASH_TASK_RUN_1');
	await workbench.quickaccess.runCommand('workbench.action.tasks.reRunTask');
	await expect.poll(() => readFile(join(testWorkspace.directory, 'task-runs.txt'), 'utf8')).toBe('2');
	await expect(workbench.terminal.activeInstance).toContainText('ASH_TASK_RUN_2');
	await workbench.page.getByRole('tab', { name: 'Tasks', exact: true }).click();
	await expect(workbench.page.locator('.ash-task-run')).toContainText('Smoke build — succeeded (0)');
});

test('terminating a running workspace task stops its terminal and records cancellation', async ({ workbench }) => {
	await workbench.quickaccess.runCommand('workbench.action.tasks.runTask');
	await workbench.quickaccess.select('Smoke watch');
	await expect(workbench.terminal.activeInstance).toContainText('ASH_TASK_WATCH_READY');
	await workbench.quickaccess.runCommand('workbench.action.tasks.terminate');
	await workbench.page.getByRole('tab', { name: 'Tasks', exact: true }).click();
	await expect(workbench.page.locator('.ash-task-run')).toContainText('Smoke watch — canceled');
});

test('command-only tasks own their shell process and retain output and exit without terminal input echo', async ({ application, workbench, testWorkspace }) => {
	const directory = testWorkspace.directory;
	const log = join(directory, 'command-only.jsonl');
	await writeFile(log, '');
	await writeFile(join(directory, 'command-only.cjs'), `const fs = require('node:fs'); fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ pid: process.pid, argument: process.argv[2] }) + '\\n'); console.log('COMMAND_ONLY_OUTPUT'); process.exitCode = process.argv[2] === 'ARGUMENT_FAILURE' ? 7 : 0;\n`);
	await writeFile(join(directory, '.vscode', 'tasks.json'), JSON.stringify({
		version: '2.0.0', tasks: ['Success', 'Failure'].map(name => ({ label: `Command-only ${name}`, command: `node command-only.cjs ARGUMENT_${name.toUpperCase()}`, presentation: { echo: false, panel: 'new' } })),
	}));
	for (const name of ['Success', 'Failure']) {
		await workbench.quickaccess.runCommand('workbench.action.tasks.runTask');
		await workbench.quickaccess.select(`Command-only ${name}`);
		await expect(workbench.terminal.activeInstance).toContainText('COMMAND_ONLY_OUTPUT');
		await expect(workbench.page.locator('.ash-terminal-tabs [role="tab"][aria-selected="true"]').locator('..')).toHaveAttribute('data-state', 'exited');
		await expect(workbench.terminal.activeInstance).not.toContainText(`ARGUMENT_${name.toUpperCase()}`);
		const tasksTab = workbench.page.getByRole('tab', { name: 'Tasks', exact: true });
		if (await tasksTab.isVisible()) {
			await tasksTab.click();
		} else {
			await workbench.menus.select(application, () => workbench.page.getByRole('tab', { name: 'Additional views', exact: true }).click(), ['Tasks']);
		}
		await expect(workbench.page.locator('.ash-task-run').filter({ hasText: `Command-only ${name}` })).toContainText(name === 'Success' ? 'succeeded (0)' : 'failed (7)');
	}
	const executed: { pid: number; argument: string; }[] = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
	expect(executed.map(value => value.argument)).toEqual(['ARGUMENT_SUCCESS', 'ARGUMENT_FAILURE']);
	expect(new Set(executed.map(value => value.pid)).size).toBe(2);
	for (const { pid } of executed) {
		await expect.poll(() => { try { process.kill(pid, 0); return true; } catch { return false; } }).toBe(false);
	}
});

for (const locale of ['en', 'zh-CN']) {
	test(`task command echo defaults on, changes on reuse and stays out of problem matchers (${locale})`, async ({ application, workbench, testWorkspace, restartWorkbench }) => {
		if (locale === 'zh-CN') {
			await workbench.quickaccess.runCommand('workbench.action.configureLocale');
			const language = workbench.page.getByRole('dialog', { name: 'Select Display Language' }).getByRole('combobox');
			await language.fill('简体中文');
			await language.press('Enter');
			({ application, workbench } = await restartWorkbench());
			await expect(workbench.page.getByRole('button', { name: '搜索命令', exact: true })).toBeVisible();
		}
		const directory = testWorkspace.directory;
		await writeFile(join(directory, 'real.ts'), '// task diagnostic source\n');
		await writeFile(join(directory, 'echo-task.cjs'), "const fs = require('node:fs'); fs.appendFileSync('echo-argv.jsonl', JSON.stringify(process.argv.slice(2)) + '\\n'); console.log('ACTUAL_ECHO_TASK_OUTPUT'); console.log('real.ts:1:1: error: ACTUAL_DIAGNOSTIC');\n");
		const args = ['', '$HOME', 'two words', 'ECHO_PHANTOM.ts:1:1: error: DISPLAY_ONLY'];
		const tabs = workbench.page.locator('.ash-terminal-tabs [role="tab"]');
		let screen: import('@playwright/test').ElementHandle | null = null;
		try {
			for (const echo of [undefined, false, true]) {
				await writeFile(join(directory, '.vscode', 'tasks.json'), JSON.stringify({
					version: '2.0.0', tasks: [{
						label: 'Echo task', type: 'process', command: process.execPath, args: ['${workspaceFolder}/echo-task.cjs', ...args],
						presentation: { echo, panel: 'dedicated', clear: true },
						problemMatcher: { owner: 'echo-smoke', fileLocation: 'relative', pattern: { regexp: '(ECHO_PHANTOM\\.ts|real\\.ts):(\\d+):(\\d+): (error): (.*)', file: 1, line: 2, column: 3, severity: 4, message: 5 } },
					}]
				}));
				await workbench.quickaccess.runCommand('workbench.action.tasks.runTask');
				await workbench.quickaccess.select('Echo task');
				await expect(workbench.terminal.activeInstance).toContainText('ACTUAL_ECHO_TASK_OUTPUT');
				await expect(tabs.locator('..')).toHaveAttribute('data-state', 'exited');
				if (echo === false) {
					await expect(workbench.terminal.activeInstance).not.toContainText('DISPLAY_ONLY');
				} else {
					await expect(workbench.terminal.activeInstance).toContainText(locale === 'zh-CN' ? '正在执行任务：' : 'Executing task:');
					await expect(workbench.terminal.activeInstance).toContainText('"" "$HOME" "two words" "ECHO_PHANTOM.ts:1:1: error: DISPLAY_ONLY"');
				}
				if (!screen) { screen = await workbench.terminal.activeInstance.elementHandle(); }
				expect(await screen!.evaluate(element => element === document.querySelector('.ash-terminal-instance:not([hidden])'))).toBe(true);
				await expect(tabs).toHaveCount(1);
				const problems = workbench.page.getByRole('tab', { name: locale === 'zh-CN' ? '问题' : 'Problems', exact: true });
				if (await problems.isVisible()) { await problems.click(); }
				else { await workbench.menus.select(application, () => workbench.page.getByRole('tab', { name: locale === 'zh-CN' ? '其他视图' : 'Additional views', exact: true }).click(), [locale === 'zh-CN' ? '问题' : 'Problems']); }
				await expect(workbench.page.locator('.ash-problems-results')).toContainText('ACTUAL_DIAGNOSTIC');
				await expect(workbench.page.locator('.ash-problems-results')).not.toContainText('DISPLAY_ONLY');
			}
			expect((await readFile(join(directory, 'echo-argv.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))).toEqual([args, args, args]);
		} finally {
			await screen?.dispose();
		}
	});
}

test('search problem matchers resolve nested literal filenames and exclude directories before dependent tasks complete', async ({ workbench, testWorkspace }) => {
	const directory = testWorkspace.directory;
	const included = join(directory, 'matcher-search[work]', 'nested');
	const excluded = join(directory, 'matcher-search[work]', 'ignored');
	await mkdir(included, { recursive: true });
	await mkdir(excluded, { recursive: true });
	await writeFile(join(included, 'search[entry].ts'), '\nlet SEARCH_MATCHER_FOUND = true;\n');
	await writeFile(join(excluded, 'search[entry].ts'), '\nlet SEARCH_MATCHER_EXCLUDED = true;\n');
	await writeFile(join(directory, 'search-matcher.cjs'), "process.stdout.write('search[entry].ts(2,3): warning TS321: SEARCH_FILE_DIAGNOSTIC');");
	await writeFile(join(directory, 'search-follow.cjs'), "require('node:fs').writeFileSync('search-followed.txt', 'completed');");
	await writeFile(join(directory, '.vscode', 'tasks.json'), JSON.stringify({
		version: '2.0.0', tasks: [
			{ label: 'Search diagnostic', type: 'process', command: process.execPath, args: ['${workspaceFolder}/search-matcher.cjs'], presentation: { echo: false, reveal: 'never', revealProblems: 'onProblem' }, problemMatcher: { base: '$tsc', fileLocation: ['search', { include: '${workspaceFolder}/matcher-search[work]', exclude: '${workspaceFolder}/matcher-search[work]/ignored' }] } },
			{ label: 'After search', type: 'process', command: process.execPath, args: ['${workspaceFolder}/search-follow.cjs'], dependsOn: 'Search diagnostic', presentation: { echo: false, reveal: 'never' } },
		]
	}));
	await workbench.quickaccess.runCommand('workbench.action.tasks.runTask');
	await workbench.quickaccess.select('After search');
	await expect.poll(async () => readFile(join(directory, 'search-followed.txt'), 'utf8').catch(() => '')).toBe('completed');
	const diagnostics = workbench.page.locator('.ash-problems-results');
	await expect(diagnostics).toBeVisible();
	await expect(diagnostics).toContainText('SEARCH_FILE_DIAGNOSTIC');
	const problem = diagnostics.getByRole('button', { name: /SEARCH_FILE_DIAGNOSTIC/ });
	await expect(problem).toHaveAttribute('title', 'SEARCH_FILE_DIAGNOSTIC — search[entry].ts:2:3');
	await problem.click();
	await workbench.editors.groupAt(0).editor.waitForEditorContents(contents => contents.includes('SEARCH_MATCHER_FOUND') && !contents.includes('SEARCH_MATCHER_EXCLUDED'));
});

test('core compiler and lint matchers publish real task output and preserve shared diagnostic owners', async ({ workbench, testWorkspace }) => {
	const directory = testWorkspace.directory;
	const lines = [
		`${directory}/main.cs(2,3): category warning CS7: BUILTIN_MICROSOFT`,
		'main.ts(3,4): 102 BUILTIN_GULP',
		`BUILTIN_LESS in file ${directory}/style.less line no. 3`,
		'main.go:4:5: BUILTIN_GO',
		`${directory}/compact.js: line 2, col 3, Warning - BUILTIN_COMPACT (semi)`,
		`${directory}/stylish.js`, '  3:4 warning BUILTIN_STYLISH_CODE  semi', '  5:6 error BUILTIN_STYLISH_NO_CODE',
		`${directory}/jshint.js: line 2, col 3, BUILTIN_JSHINT (W033)`,
		`${directory}/jshint-stylish.js`, '  line 3 col 4 BUILTIN_JSHINT_CODE (W033)', '  line 5 col 6 BUILTIN_JSHINT_NO_CODE',
	];
	for (const file of ['main.cs', 'main.ts', 'main.go', 'style.less', 'compact.js', 'stylish.js', 'jshint.js', 'jshint-stylish.js']) {
		await writeFile(join(directory, file), '\n\n\nBUILTIN_SOURCE_TARGET\n\n\n');
	}
	await writeFile(join(directory, 'builtin-matchers.cjs'), `console.log(${JSON.stringify(lines.slice(0, 8).join('\n'))});`);
	await writeFile(join(directory, 'builtin-jshint.cjs'), `console.log(${JSON.stringify(lines.slice(8).join('\n'))});`);
	const presentation = { echo: false, reveal: 'never', revealProblems: 'onProblem' };
	await writeFile(join(directory, '.vscode', 'tasks.json'), JSON.stringify({
		version: '2.0.0', tasks: [
			{ label: 'Builtin matchers', type: 'process', command: process.execPath, args: ['${workspaceFolder}/builtin-matchers.cjs'], presentation, problemMatcher: ['$msCompile', '$gulp-tsc', '$lessCompile', '$go', '$eslint-compact', '$eslint-stylish'] },
			{ label: 'Builtin JSHint', type: 'process', command: process.execPath, args: ['${workspaceFolder}/builtin-jshint.cjs'], presentation, problemMatcher: ['$jshint', '$jshint-stylish'] },
		]
	}));
	await workbench.quickaccess.runCommand('workbench.action.tasks.runTask');
	await workbench.quickaccess.select('Builtin matchers');
	const diagnostics = workbench.page.locator('.ash-problems-results');
	await expect(diagnostics).toBeVisible();
	await expect(diagnostics.locator('.ash-problems-item')).toHaveCount(7);
	await workbench.quickaccess.runCommand('workbench.action.tasks.runTask');
	await workbench.quickaccess.select('Builtin JSHint');
	await expect(diagnostics.locator('.ash-problems-item')).toHaveCount(10);
	for (const message of ['BUILTIN_MICROSOFT', 'BUILTIN_GULP', 'BUILTIN_LESS', 'BUILTIN_GO', 'BUILTIN_COMPACT', 'BUILTIN_STYLISH_CODE', 'BUILTIN_STYLISH_NO_CODE', 'BUILTIN_JSHINT', 'BUILTIN_JSHINT_CODE', 'BUILTIN_JSHINT_NO_CODE']) {
		await expect(diagnostics.getByRole('button', { name: new RegExp(message + '(?:\\s|$)') })).toBeVisible();
	}
	await expect(diagnostics.locator('.ash-problems-item').filter({ hasText: 'BUILTIN_STYLISH_NO_CODE' }).locator('.ash-problems-source')).toHaveText('eslint');
	await expect(diagnostics.locator('.ash-problems-item').filter({ hasText: 'BUILTIN_JSHINT_NO_CODE' })).toHaveClass(/\berror\b/);
	await expect(diagnostics.locator('.ash-problems-item').filter({ hasText: 'BUILTIN_JSHINT_NO_CODE' }).locator('.ash-problems-source')).toHaveText('jshint');
	await diagnostics.getByRole('button', { name: /BUILTIN_GO/ }).click();
	await workbench.editors.groupAt(0).editor.waitForEditorContents(contents => contents.includes('BUILTIN_SOURCE_TARGET'));
});

test('problem search rejects an unauthorized directory before execution in Chinese', async ({ workbench, testWorkspace, restartWorkbench }) => {
	await workbench.quickaccess.runCommand('workbench.action.configureLocale');
	const language = workbench.page.getByRole('dialog', { name: 'Select Display Language' }).getByRole('combobox');
	await language.fill('简体中文');
	await language.press('Enter');
	({ workbench } = await restartWorkbench());
	await writeFile(join(testWorkspace.directory, '.vscode', 'tasks.json'), JSON.stringify({ version: '2.0.0', tasks: [{ label: 'Outside search', type: 'process', command: process.execPath, args: ['${workspaceFolder}/smoke-task.cjs'], problemMatcher: { base: '$tsc', fileLocation: ['search', { include: '/outside-search' }] } }] }));
	await workbench.quickaccess.runCommand('workbench.action.tasks.runTask');
	await workbench.quickaccess.select('Outside search');
	await expect(workbench.page.locator('.ash-notification', { hasText: '问题匹配器搜索目录“/outside-search”不在当前工作区内。' })).toBeVisible();
	expect(await readFile(join(testWorkspace.directory, 'task-runs.txt'), 'utf8')).toBe('0');
	await expect(workbench.page.locator('.ash-terminal-tab')).toHaveCount(0);
	await writeFile(join(testWorkspace.directory, '.vscode', 'tasks.json'), JSON.stringify({ version: '2.0.0', tasks: [{ label: 'Unknown pattern', type: 'process', command: process.execPath, args: ['${workspaceFolder}/smoke-task.cjs'], problemMatcher: { pattern: '$missing-pattern' } }] }));
	await workbench.quickaccess.runCommand('workbench.action.tasks.runTask');
	await workbench.quickaccess.select('Unknown pattern');
	await expect(workbench.page.locator('.ash-notification', { hasText: '未知的问题模式“$missing-pattern”' })).toBeVisible();
	expect(await readFile(join(testWorkspace.directory, 'task-runs.txt'), 'utf8')).toBe('0');
	await expect(workbench.page.locator('.ash-terminal-tab')).toHaveCount(0);
});

test('captured severity aliases and configured compiler fallback reach Problems', async ({ workbench, testWorkspace }) => {
	const directory = testWorkspace.directory;
	const lines = [join(directory, 'severity.ts') + '(2,3): category fatal   error C7: SEVERITY_FATAL', 'severity.ts|2|WARN SEVERITY_WARN', 'severity.ts|2|Hint SEVERITY_HINT', 'severity.ts|2|E SEVERITY_ERROR', 'severity.ts|2|i SEVERITY_FALLBACK'];
	await writeFile(join(directory, 'severity.cjs'), `console.log(${JSON.stringify(lines.join('\n'))});`);
	await writeFile(join(directory, 'severity.ts'), '\nlet severity = true;\n');
	await writeFile(join(directory, '.vscode', 'tasks.json'), JSON.stringify({ version: '2.0.0', tasks: [{ label: 'Matcher severity', type: 'process', command: process.execPath, args: ['${workspaceFolder}/severity.cjs'], presentation: { echo: false, reveal: 'never', revealProblems: 'onProblem' }, problemMatcher: [{ base: '$msCompile', severity: 'warning' }, { severity: 'warning', pattern: { regexp: '^(.+)\\|(\\d+)\\|([^ ]+) (.+)$', file: 1, line: 2, severity: 3, message: 4 } }] }] }));
	await workbench.quickaccess.runCommand('workbench.action.tasks.runTask');
	await workbench.quickaccess.select('Matcher severity');
	const diagnostics = workbench.page.locator('.ash-problems-results');
	await expect(diagnostics.locator('.ash-problems-item')).toHaveCount(5);
	for (const [message, severity] of [['SEVERITY_FATAL', 'warning'], ['SEVERITY_WARN', 'warning'], ['SEVERITY_HINT', 'information'], ['SEVERITY_ERROR', 'error'], ['SEVERITY_FALLBACK', 'warning']]) {
		await expect(diagnostics.locator('.ash-problems-item').filter({ hasText: message })).toHaveClass(new RegExp(`\\b${severity}\\b`, 'u'));
	}
});

test('compiler zero and backward coordinates reach Problems and navigate to normalized positions', async ({ workbench, testWorkspace }) => {
	const directory = testWorkspace.directory;
	await writeFile(join(directory, 'coordinates.ts'), 'COORDINATE_SOURCE_TARGET\n\nlet third = true;\n');
	await writeFile(join(directory, 'coordinates.cjs'), `console.log(${JSON.stringify(join(directory, 'coordinates.ts') + '(0,0): error Z0: ZERO_COORDINATE')}); console.log(${JSON.stringify(join(directory, 'coordinates.ts') + '(3,4,1,0): warning B0: BACKWARD_COORDINATE')}); console.log(${JSON.stringify(join(directory, 'coordinates.ts') + ': warning : ABSENT_COORDINATE')});`);
	await writeFile(join(directory, '.vscode', 'tasks.json'), JSON.stringify({ version: '2.0.0', tasks: [{ label: 'Compiler coordinates', type: 'process', command: process.execPath, args: ['${workspaceFolder}/coordinates.cjs'], problemMatcher: '$msCompile', presentation: { echo: false, reveal: 'never', revealProblems: 'onProblem' } }] }));
	await workbench.quickaccess.runCommand('workbench.action.tasks.runTask');
	await workbench.quickaccess.select('Compiler coordinates');
	const page = workbench.page;
	const diagnostics = page.locator('.ash-problems-results');
	await expect(diagnostics.locator('.ash-problems-item')).toHaveCount(2);
	await expect(diagnostics).toContainText('ZERO_COORDINATE');
	await expect(diagnostics).toContainText('BACKWARD_COORDINATE');
	await expect(diagnostics).not.toContainText('ABSENT_COORDINATE');
	await diagnostics.getByRole('button', { name: /ZERO_COORDINATE/u }).click();
	await workbench.editors.groupAt(0).editor.waitForEditorContents(contents => contents.includes('COORDINATE_SOURCE_TARGET'));
	await expect(page.getByRole('button', { name: 'Ln 1, Col 1', exact: true })).toBeVisible();
	await diagnostics.getByRole('button', { name: /BACKWARD_COORDINATE/u }).click();
	await expect(page.getByRole('button', { name: 'Ln 3, Col 4', exact: true })).toBeVisible();
});

test('task pattern defaults and multiline line-only diagnostics reach Problems', async ({ application, workbench, testWorkspace }) => {
	const directory = testWorkspace.directory;
	await writeFile(join(directory, 'pattern-defaults.cjs'), "console.log('single.ts:2:3 error'); console.log('FILE multiline.ts'); console.log('4 warning LINE_ONLY_DIAGNOSTIC'); console.log('5 error SECOND_LINE_DIAGNOSTIC');");
	await writeFile(join(directory, 'single.ts'), '\nlet single = true;\n');
	await writeFile(join(directory, 'multiline.ts'), '\n\n\nlet first = true;\nlet second = true;\n');
	await writeFile(join(directory, '.vscode', 'tasks.json'), JSON.stringify({
		version: '2.0.0', tasks: [{
			label: 'Pattern defaults', type: 'process', command: process.execPath, args: ['${workspaceFolder}/pattern-defaults.cjs'], presentation: { echo: false },
			problemMatcher: [
				{ owner: 'single-pattern', severity: 'warning', pattern: { regexp: '^(single\\.ts):(\\d+):(\\d+) (.+)$' } },
				{ owner: 'array-pattern', pattern: [{ regexp: '^FILE (.+)$', file: 1 }, { regexp: '^(\\d+) (error|warning) (.+)$', line: 1, severity: 2, message: 3, loop: true }] },
			],
		}]
	}));
	await workbench.quickaccess.runCommand('workbench.action.tasks.runTask');
	await workbench.quickaccess.select('Pattern defaults');
	await expect(workbench.terminal.activeInstance).toContainText('SECOND_LINE_DIAGNOSTIC');
	const problems = workbench.page.getByRole('tab', { name: 'Problems', exact: true });
	if (await problems.isVisible()) {
		await problems.click();
	} else {
		await workbench.menus.select(application, () => workbench.page.getByRole('tab', { name: 'Additional views', exact: true }).click(), ['Problems']);
	}
	const diagnostics = workbench.page.locator('.ash-problems-results');
	await expect(diagnostics).toContainText('single.ts:2:3 error');
	await expect(diagnostics).toContainText('LINE_ONLY_DIAGNOSTIC');
	await expect(diagnostics).toContainText('SECOND_LINE_DIAGNOSTIC');
});

for (const locale of ['en', 'zh-CN']) {
	test(`task reuse notice preserves shortcuts, updates on reuse and closes only after exit (${locale})`, async ({ application, workbench, testWorkspace, restartWorkbench }) => {
		const directory = testWorkspace.directory;
		if (locale === 'zh-CN') {
			await workbench.quickaccess.runCommand('workbench.action.configureLocale');
			const language = workbench.page.getByRole('dialog', { name: 'Select Display Language' }).getByRole('combobox');
			await language.fill('简体中文');
			await language.press('Enter');
			({ application, workbench } = await restartWorkbench());
			await expect(workbench.page.getByRole('button', { name: '搜索命令', exact: true })).toBeVisible();
		}
		const release = join(directory, 'reuse-release');
		await writeFile(join(directory, 'reuse-notice.cjs'), `const fs = require('node:fs'); console.log('REUSE_PROCESS_READY'); const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) { clearInterval(timer); console.log('REUSE_PROCESS_FINAL'); } }, 30);`);
		const configure = async (showReuseMessage?: boolean): Promise<void> => {
			await writeFile(join(directory, '.vscode', 'tasks.json'), JSON.stringify({ version: '2.0.0', tasks: [{ label: 'Reuse notice', type: 'process', command: process.execPath, args: ['${workspaceFolder}/reuse-notice.cjs'], presentation: { panel: 'dedicated', clear: true, echo: false, showReuseMessage } }] }));
		};
		const notice = locale === 'zh-CN' ? '终端将被任务重用，按任意键关闭。' : 'Terminal will be reused by tasks, press any key to close it.';
		const page = workbench.page;
		const input = workbench.terminal.activeInstance.locator('textarea.xterm-helper-textarea');
		const tabs = page.locator('.ash-terminal-tabs [role="tab"]');
		await configure(false);
		await workbench.quickaccess.runCommand('workbench.action.tasks.runTask');
		await workbench.quickaccess.select('Reuse notice');
		await expect(workbench.terminal.activeInstance).toContainText('REUSE_PROCESS_READY');
		await writeFile(release, 'exit');
		await expect(tabs.locator('..')).toHaveAttribute('data-state', 'exited');
		await expect(workbench.terminal.activeInstance).not.toContainText(notice);
		await input.focus();
		await input.press('Alt+F1');
		const help = page.getByRole('textbox', { name: locale === 'zh-CN' ? '无障碍帮助' : 'Accessibility Help', exact: true });
		await expect(help).toHaveValue(/presentation\.showReuseMessage/);
		await help.press('Escape');
		await expect(input).toBeFocused();
		await configure();
		await unlink(release);
		await workbench.quickaccess.runCommand('workbench.action.tasks.reRunTask');
		await expect(workbench.terminal.activeInstance).toContainText('REUSE_PROCESS_READY');
		await expect(tabs).toHaveCount(1);
		await expect(tabs.locator('..')).toHaveAttribute('data-state', 'running');
		await input.focus();
		await input.press('Alt+F2');
		const accessible = page.getByRole('textbox', { name: locale === 'zh-CN' ? '无障碍视图' : 'Accessible View', exact: true });
		await expect(accessible).toHaveValue(/REUSE_PROCESS_READY/);
		await writeFile(release, 'exit');
		await expect(accessible).toHaveValue(new RegExp(notice));
		await expect(accessible).toHaveValue(/REUSE_PROCESS_FINAL/);
		await accessible.press('Escape');
		await expect(input).toBeFocused();
		await input.press('Alt+F1');
		await expect(help).toHaveValue(/presentation\.showReuseMessage/);
		await help.press('Control+Alt+h');
		await help.press('Escape');
		await expect(input).toHaveAttribute('aria-label', locale === 'zh-CN' ? '终端输入' : 'Terminal input');
		await expect(tabs).toHaveCount(1);
		await input.press('a');
		await expect(tabs).toHaveCount(0);
		await configure(false);
		await workbench.quickaccess.runCommand('workbench.action.tasks.reRunTask');
		await expect(tabs.locator('..')).toHaveAttribute('data-state', 'exited');
		await expect(workbench.terminal.activeInstance).not.toContainText(notice);
		await input.focus();
		await input.press('Enter');
		await expect(tabs).toHaveCount(0);
	});
}

for (const locale of ['en', 'zh-CN']) {
	test(`new task terminals display the close notice even when reuse notices are disabled (${locale})`, async ({ workbench, testWorkspace, restartWorkbench }) => {
		if (locale === 'zh-CN') {
			await workbench.quickaccess.runCommand('workbench.action.configureLocale');
			const language = workbench.page.getByRole('dialog', { name: 'Select Display Language' }).getByRole('combobox');
			await language.fill('简体中文');
			await language.press('Enter');
			({ workbench } = await restartWorkbench());
		}
		await writeFile(join(testWorkspace.directory, '.vscode', 'tasks.json'), JSON.stringify({ version: '2.0.0', tasks: [{ label: 'New close notice', type: 'process', command: process.execPath, args: ['-e', "console.log('NEW_TERMINAL_COMPLETE')"], presentation: { panel: 'new', echo: false, showReuseMessage: false } }] }));
		await workbench.quickaccess.runCommand('workbench.action.tasks.runTask');
		await workbench.quickaccess.select('New close notice');
		await expect(workbench.terminal.activeInstance).toContainText(locale === 'zh-CN' ? '按任意键关闭终端。' : 'Press any key to close the terminal.');
		const tabs = workbench.page.locator('.ash-terminal-tabs [role="tab"]');
		await expect(tabs.locator('..')).toHaveAttribute('data-state', 'exited');
		const input = workbench.terminal.activeInstance.locator('textarea.xterm-helper-textarea');
		await input.focus();
		await input.press('Enter');
		await expect(tabs).toHaveCount(0);
	});
}

for (const panel of [undefined, 'shared', 'dedicated', 'new'] as const) {
	test(`configured ${panel ?? 'default'} task terminals replace processes and preserve the selected screen policy`, async ({ workbench, testWorkspace }) => {
		const effectivePanel = panel ?? 'shared';
		const directory = testWorkspace.directory;
		const log = join(directory, 'panel-processes.jsonl');
		await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'task-panels', version: '1.0.0' }));
		await unlink(join(directory, 'Cargo.toml'));
		await Promise.all(['First', 'Second'].map(name => mkdir(join(directory, name))));
		await writeFile(log, '');
		await writeFile(join(directory, 'panel-process.cjs'), `const fs = require('node:fs'); const log = ${JSON.stringify(log)}; const count = fs.readFileSync(log, 'utf8').trim().split('\\n').filter(Boolean).length + 1; fs.appendFileSync(log, JSON.stringify({ name: process.argv[2], pid: process.pid, cwd: process.cwd(), value: process.env.ASH_PANEL_VALUE }) + '\\n'); console.log('ASH_PANEL_' + process.argv[2] + '_' + count);\n`);
		const configure = async (clear = false): Promise<void> => {
			await writeFile(join(directory, '.vscode', 'tasks.json'), JSON.stringify({ version: '2.0.0', tasks: ['First', 'Second'].map(name => ({ label: name, type: 'process', command: process.execPath, args: [join(directory, 'panel-process.cjs'), name], options: { cwd: join(directory, name), env: { ASH_PANEL_VALUE: name } }, presentation: { panel, clear } })) }));
		};
		const executed = async (): Promise<{ name: string; pid: number; cwd: string; value: string; }[]> => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
		const tabs = workbench.page.locator('.ash-terminal-tabs [role="tab"]');
		const run = async (name: string, count: number): Promise<void> => {
			await workbench.quickaccess.runCommand('workbench.action.tasks.runTask');
			await workbench.quickaccess.select(name);
			await expect(workbench.terminal.activeInstance).toContainText(`ASH_PANEL_${name}_${count}`);
			// A process can write its result before it exits; only completed task slots may be reused.
			await expect(workbench.page.locator('.ash-terminal-tabs [role="tab"][aria-selected="true"]').locator('..')).toHaveAttribute('data-state', 'exited');
		};
		await configure();
		await run('First', 1);
		const firstScreen = await workbench.terminal.activeInstance.elementHandle();
		expect(firstScreen).not.toBeNull();
		await run('Second', 2);
		expect(await firstScreen!.evaluate(element => element === document.querySelector('.ash-terminal-instance:not([hidden])'))).toBe(effectivePanel === 'shared');
		await run('First', 3);
		expect(await firstScreen!.evaluate(element => element === document.querySelector('.ash-terminal-instance:not([hidden])'))).toBe(panel !== 'new');
		await expect(tabs).toHaveCount(effectivePanel === 'shared' ? 1 : panel === 'dedicated' ? 2 : 3);
		const processes = await executed();
		expect(processes.map(({ name, cwd, value }) => ({ name, cwd, value }))).toEqual(['First', 'Second', 'First'].map(name => ({ name, cwd: join(directory, name), value: name })));
		expect(new Set(processes.map(process => process.pid)).size).toBe(3);
		if (panel !== 'new') {
			await expect(workbench.terminal.activeInstance).toContainText('ASH_PANEL_First_1');
			await configure(true);
			await run('First', 4);
			await expect(workbench.terminal.activeInstance).not.toContainText('ASH_PANEL_First_1');
			await expect(workbench.terminal.activeInstance).not.toContainText('ASH_PANEL_First_3');
			await expect(tabs).toHaveCount(effectivePanel === 'shared' ? 1 : 2);
		}
		await firstScreen!.dispose();
	});
}

test('invalid task presentation is rejected before execution in the selected display language', async ({ workbench, testWorkspace, restartWorkbench }) => {
	await workbench.quickaccess.runCommand('workbench.action.configureLocale');
	const language = workbench.page.getByRole('dialog', { name: 'Select Display Language' }).getByRole('combobox');
	await language.fill('简体中文');
	await language.press('Enter');
	({ workbench } = await restartWorkbench());
	await writeFile(join(testWorkspace.directory, '.vscode', 'tasks.json'), JSON.stringify({ version: '2.0.0', tasks: [{ label: 'Invalid presentation', type: 'shell', command: 'node smoke-task.cjs', presentation: { panel: 'invalid' } }] }));
	await workbench.quickaccess.runCommand('workbench.action.tasks.runTask');
	await expect(workbench.page.locator('.ash-notification', { hasText: '任务呈现选项无效。' })).toBeVisible();
	expect(await readFile(join(testWorkspace.directory, 'task-runs.txt'), 'utf8')).toBe('0');
});

test('task presentation preserves editor focus, reveals errors and closes only the completed task terminal', async ({ workbench, testWorkspace }) => {
	const directory = testWorkspace.directory;
	const log = join(directory, 'task-presentation.jsonl');
	await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'task-presentation', version: '1.0.0' }));
	await unlink(join(directory, 'Cargo.toml'));
	await writeFile(join(directory, 'main.ts'), 'export const presentation = true;\n');
	await writeFile(log, '');
	await writeFile(join(directory, 'presentation-task.cjs'), `const fs = require('node:fs'); const name = process.argv[2]; fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({name, pid: process.pid}) + '\\n'); console.log('ASH_PRESENTATION_' + name); if (name === 'Silent diagnostic') { console.log('main.ts(1,3): error TS1111: Presentation diagnostic'); setInterval(() => {}, 1000); } else if (name === 'Close output') { setInterval(() => { if (fs.existsSync(${JSON.stringify(join(directory, 'close-permission'))})) process.exit(0); }, 25); } else process.exit(name === 'Silent failure' ? 7 : 0);\n`);
	const definitions = [
		{ label: 'Never output', presentation: { reveal: 'never', focus: true } },
		{ label: 'Always output', presentation: {} },
		{ label: 'Focused output', presentation: { focus: true } },
		{ label: 'Silent success', presentation: { reveal: 'silent' } },
		{ label: 'Silent failure', presentation: { reveal: 'silent' } },
		{ label: 'Silent diagnostic', presentation: { reveal: 'silent' }, problemMatcher: '$tsc' },
		{ label: 'Close output', presentation: { close: true, panel: 'shared' } },
	];
	await writeFile(join(directory, '.vscode', 'tasks.json'), JSON.stringify({ version: '2.0.0', tasks: definitions.map(task => ({ ...task, type: 'process', command: process.execPath, args: [join(directory, 'presentation-task.cjs'), task.label] })) }));
	await workbench.openExplorer();
	await workbench.page.locator('.ash-explorer').getByRole('treeitem', { name: 'main.ts', exact: true }).dblclick();
	const editor = workbench.editors.groupAt(0).editor;
	await editor.waitForEditorContents(content => content.includes('export const presentation'));
	const records = async (): Promise<{ name: string; pid: number; }[]> => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
	const run = async (name: string): Promise<void> => {
		await workbench.quickaccess.runCommand('workbench.action.tasks.runTask');
		await workbench.quickaccess.select(name);
		await expect.poll(async () => (await records()).some(record => record.name === name)).toBe(true);
	};
	const waitForExit = async (name: string): Promise<void> => {
		const pid = (await records()).find(record => record.name === name)!.pid;
		await expect.poll(() => { try { process.kill(pid, 0); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true; throw error; } }).toBe(true);
	};
	const hide = async (): Promise<void> => {
		if (await workbench.page.locator('.ash-workbench-panel').isVisible()) {
			await workbench.quickaccess.runCommand('workbench.action.closePanel');
		}
		await expect(workbench.terminal.activeInstance).toHaveCount(0);
		await editor.waitForEditorFocus();
	};
	await hide();
	await run('Never output');
	await waitForExit('Never output');
	await expect(workbench.terminal.activeInstance).toHaveCount(0);
	await expect(editor.input).toBeFocused();
	await workbench.quickaccess.runCommand('workbench.action.terminal.focus');
	await expect(workbench.terminal.activeInstance).toContainText('ASH_PRESENTATION_Never output');
	await hide();
	await run('Always output');
	await expect(workbench.terminal.activeInstance).toContainText('ASH_PRESENTATION_Always output');
	await expect(editor.input).toBeFocused();
	await run('Focused output');
	await expect(workbench.terminal.activeInstance).toContainText('ASH_PRESENTATION_Focused output');
	await expect(workbench.terminal.activeInstance.locator('.xterm-helper-textarea')).toBeFocused();
	await hide();
	await run('Silent success');
	await waitForExit('Silent success');
	await expect(workbench.terminal.activeInstance).toHaveCount(0);
	await expect(editor.input).toBeFocused();
	await run('Silent failure');
	await expect(workbench.terminal.activeInstance).toContainText('ASH_PRESENTATION_Silent failure');
	await expect(editor.input).toBeFocused();
	await hide();
	await run('Silent diagnostic');
	await expect(workbench.terminal.activeInstance).toContainText('Presentation diagnostic');
	await expect(editor.input).toBeFocused();
	await workbench.quickaccess.runCommand('workbench.action.tasks.terminate');
	await waitForExit('Silent diagnostic');
	await hide();
	await run('Close output');
	await expect(workbench.terminal.activeInstance).toContainText('ASH_PRESENTATION_Close output');
	const id = await workbench.page.locator('.ash-terminal-tabs [role="tab"][aria-selected="true"]').getAttribute('id');
	expect(id).not.toBeNull();
	await writeFile(join(directory, 'close-permission'), 'release');
	await expect(workbench.page.locator(`[id="${id}"]`)).toHaveCount(0);
	await waitForExit('Close output');
	await expect(editor.input).toBeFocused();
});

test('task problem reveal policies prioritize diagnostics and wait for foreground completion or a background matcher', async ({ workbench, testWorkspace }) => {
	const directory = testWorkspace.directory;
	const log = join(directory, 'problem-reveal.jsonl');
	await writeFile(log, '');
	await writeFile(join(directory, 'main.ts'), 'export const reveal = true;\n');
	await writeFile(join(directory, 'problem-reveal.cjs'), `
const fs = require('node:fs');
const name = process.argv[2];
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({name, pid: process.pid}) + '\\n');
console.log('ASH_REVEAL_' + name);
if (name === 'Background') console.log('BUILD');
if (name === 'Warning') process.stdout.write('main.ts(1,3): warning TS1234: Foreground warning');
if (name === 'Never') console.log('main.ts(1,3): error TS1234: Hidden diagnostic');
if (['Always', 'Warning', 'Background'].includes(name)) {
 const timer = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(directory)} + '/' + name + '.release')) return;
  clearInterval(timer);
  if (name === 'Background') {
   console.log('main.ts(1,3): error TS1234: Background error');
   console.log('READY');
   setInterval(() => {}, 1000);
  } else process.exit(0);
 }, 25);
} else process.exit(name === 'Failure' ? 7 : 0);
`);
	const definitions = [
		{ label: 'Always', presentation: { reveal: 'always', focus: true, revealProblems: 'always' } },
		{ label: 'Warning', presentation: { reveal: 'never', revealProblems: 'onProblem' }, problemMatcher: '$tsc' },
		{ label: 'Success', presentation: { reveal: 'never', revealProblems: 'onProblem' } },
		{ label: 'Failure', presentation: { reveal: 'silent', revealProblems: 'onProblem' } },
		{ label: 'Never', presentation: { reveal: 'never', revealProblems: 'never' }, problemMatcher: '$tsc' },
		{ label: 'Background', presentation: { reveal: 'never', revealProblems: 'onProblem' }, isBackground: true, problemMatcher: { base: '$tsc', background: { activeOnStart: true, beginsPattern: '^BUILD$', endsPattern: '^READY$' } } },
	];
	await writeFile(join(directory, '.vscode', 'tasks.json'), JSON.stringify({ version: '2.0.0', tasks: definitions.map(task => ({ ...task, type: 'process', command: process.execPath, args: [join(directory, 'problem-reveal.cjs'), task.label], presentation: { panel: 'new', ...task.presentation } })) }));
	const page = workbench.page;
	await workbench.quickaccess.runCommand('workbench.action.togglePanel');
	await page.getByRole('tab', { name: 'Tasks', exact: true }).click();
	// The Parts owner detaches inactive composites; retain the real rendered list
	// to observe completion without changing the panel whose reveal is under test.
	const taskList = await page.locator('.ash-tasks-list').elementHandle();
	expect(taskList).not.toBeNull();
	try {
		await workbench.quickaccess.open('main.ts');
		await workbench.quickaccess.select('main.ts');
		const editor = workbench.editors.groupAt(0).editor;
		await editor.waitForEditorContents(value => value.includes('export const reveal'));
		const hide = async (): Promise<void> => {
			if (await page.locator('.ash-workbench-panel').isVisible()) await workbench.quickaccess.runCommand('workbench.action.closePanel');
			await expect(page.locator('.ash-workbench-panel')).toBeHidden();
			await editor.waitForEditorFocus();
		};
		const run = async (name: string): Promise<void> => {
			await workbench.quickaccess.runCommand('workbench.action.tasks.runTask');
			await workbench.quickaccess.select(name);
			await expect.poll(async () => (await readFile(log, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line).name)).toContain(name);
		};
		const finished = async (name: string, status: string): Promise<void> => {
			await expect.poll(() => taskList!.textContent()).toContain(`${name} — ${status}`);
		};
		const problems = page.getByRole('tab', { name: 'Problems', exact: true });
		await hide();
		await run('Always');
		await expect(problems).toHaveAttribute('aria-selected', 'true');
		await expect(workbench.terminal.activeInstance).toHaveCount(0);
		await expect(editor.input).toBeFocused();
		await writeFile(join(directory, 'Always.release'), 'release');
		await finished('Always', 'succeeded');
		await hide();
		await run('Warning');
		await finished('Warning', 'running');
		await expect(page.locator('.ash-workbench-panel')).toBeHidden();
		await writeFile(join(directory, 'Warning.release'), 'release');
		await finished('Warning', 'succeeded');
		await expect(problems).toHaveAttribute('aria-selected', 'true');
		await expect(page.locator('.ash-problems-results')).toContainText('Foreground warning');
		await expect(editor.input).toBeFocused();
		await hide();
		for (const name of ['Success', 'Never']) {
			await run(name);
			await finished(name, 'succeeded');
			await expect(page.locator('.ash-workbench-panel')).toBeHidden();
		}
		await run('Failure');
		await finished('Failure', 'failed');
		await expect(workbench.terminal.activeInstance).toContainText('ASH_REVEAL_Failure');
		await expect(editor.input).toBeFocused();
		await hide();
		await run('Background');
		await finished('Background', 'running');
		await expect(page.locator('.ash-workbench-panel')).toBeHidden();
		await writeFile(join(directory, 'Background.release'), 'release');
		await expect(problems).toHaveAttribute('aria-selected', 'true');
		await expect(page.locator('.ash-problems-results')).toContainText('Background error');
		await expect(editor.input).not.toBeFocused();
		await workbench.quickaccess.runCommand('workbench.action.tasks.terminate');
		await finished('Background', 'canceled');
		const records = (await readFile(log, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as { name: string; pid: number; });
		const pid = records.find(record => record.name === 'Background')!.pid;
		await expect.poll(() => { try { process.kill(pid, 0); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true; throw error; } }).toBe(true);
	} finally {
		await taskList?.dispose();
	}
});

test('workspace task progress signals play the bundled sound, reload policy, and stop on cancellation', async ({ workbench }) => {
	test.setTimeout(90_000);
	const page = workbench.page;
	const audioState = { attempts: 0, played: 0, announcements: 0, audio: undefined as HTMLMediaElement | undefined };
	await page.evaluate(() => {
		const state = { attempts: 0, played: 0, announcements: 0, audio: undefined as HTMLMediaElement | undefined };
		const original = HTMLMediaElement.prototype.play;
		HTMLMediaElement.prototype.play = async function (): Promise<void> {
			state.audio = this;
			state.attempts++;
			await original.call(this);
			state.played++;
		};
		const observer = new MutationObserver(() => {
			if ([...document.querySelectorAll('.ash-aria-status')].some(region => region.textContent === 'Progress')) { state.announcements++; }
		});
		observer.observe(document.querySelector('.ash-aria-live')!, { subtree: true, childList: true });
		Object.assign(window, { ashTestProgressAudio: state, ashTestProgressObserver: observer, ashTestProgressOriginalPlay: original });
	});
	const readAudio = () => page.evaluate(() => {
		const state = (window as unknown as { ashTestProgressAudio: typeof audioState; }).ashTestProgressAudio;
		return { attempts: state.attempts, played: state.played, announcements: state.announcements, volume: state.audio?.volume, duration: state.audio?.duration, error: state.audio?.error?.code, paused: state.audio?.paused };
	});
	try {
		await workbench.settingsEditor.openUserSettingsUI();
		await workbench.settingsEditor.selectGroup('general');
		await workbench.settingsEditor.selectCategory('general');
		const settings = workbench.settingsEditor.element;
		const progress = settings.locator('[data-configuration-key="accessibility.signals.progress"]');
		const sound = progress.getByRole('textbox', { name: 'Mode 1', exact: true });
		const announcement = progress.getByRole('textbox', { name: 'Mode 2', exact: true });
		await expect(sound).toHaveValue('auto');
		await expect(announcement).toHaveValue('off');
		await sound.fill('on');
		await sound.press('Tab');
		await expect(sound).toBeEnabled();
		await announcement.fill('auto');
		await announcement.press('Tab');
		await expect(announcement).toBeEnabled();
		const reader = settings.locator('[data-configuration-key="editor.accessibilitySupport"]').getByRole('combobox');
		await reader.click();
		await page.getByRole('option', { name: 'On', exact: true }).click();
		await settings.locator('.ash-modal-editor-close').click();

		await workbench.quickaccess.runCommand('workbench.action.tasks.runTask');
		await workbench.quickaccess.select('Smoke watch');
		await expect(workbench.terminal.activeInstance).toContainText('ASH_TASK_WATCH_READY');
		await expect.poll(async () => (await readAudio()).played).toBeGreaterThan(0);
		await expect.poll(async () => (await readAudio()).announcements).toBeGreaterThan(0);
		const first = await readAudio();
		expect(first).toMatchObject({ volume: 0.7, error: undefined });
		expect(first.duration).toBeGreaterThan(0);

		await workbench.settingsEditor.openUserSettingsUI();
		await sound.fill('off');
		await sound.press('Tab');
		await expect(sound).toBeEnabled();
		const volume = settings.locator('[data-configuration-key="accessibility.signalOptions.volume"]');
		await volume.fill('25');
		await volume.press('Tab');
		await expect.poll(async () => (await readAudio()).volume).toBe(0.25);
		await settings.locator('.ash-modal-editor-close').click();
		const disabled = await readAudio();
		// Observe a full cue interval to prove policy reload suppresses playback during the same task.
		await page.waitForTimeout(5500);
		expect((await readAudio()).attempts).toBe(disabled.attempts);
		await workbench.settingsEditor.openUserSettingsUI();
		await sound.fill('on');
		await sound.press('Tab');
		await expect(sound).toBeEnabled();
		await settings.locator('.ash-modal-editor-close').click();
		await expect.poll(async () => (await readAudio()).played).toBeGreaterThan(disabled.played);
		await workbench.quickaccess.runCommand('workbench.action.tasks.terminate');
		await page.getByRole('tab', { name: 'Tasks', exact: true }).click();
		await expect(page.locator('.ash-task-run')).toContainText('Smoke watch — canceled');
		await expect.poll(async () => (await readAudio()).paused).toBe(true);
		const stopped = await readAudio();
		await page.waitForTimeout(5500);
		expect(await readAudio()).toEqual(stopped);
	} finally {
		await page.evaluate(() => {
			const state = window as unknown as { ashTestProgressObserver: MutationObserver; ashTestProgressOriginalPlay: typeof HTMLMediaElement.prototype.play; };
			state.ashTestProgressObserver.disconnect();
			HTMLMediaElement.prototype.play = state.ashTestProgressOriginalPlay;
		});
	}
});


test('task outcome signals play once for success or failure without duplicating terminal results', async ({ workbench, testWorkspace }) => {
	test.setTimeout(60_000);
	await writeFile(join(testWorkspace.directory, 'smoke-fail.cjs'), 'process.exit(7);\n');
	await writeFile(join(testWorkspace.directory, '.vscode', 'tasks.json'), JSON.stringify({
		version: '2.0.0', tasks: [
			{ label: 'Smoke build', type: 'shell', command: 'node smoke-task.cjs' },
			{ label: 'Smoke fail', type: 'shell', command: 'node smoke-fail.cjs' },
		]
	}));
	const page = workbench.page;
	const assets = Object.fromEntries(await Promise.all(['success', 'error'].map(async name => [(await readFile(join(process.cwd(), 'src/ash/platform/accessibilitySignal/browser/media', `${name}.mp3`))).toString('base64'), name])));
	await page.evaluate(assets => {
		const cues: { name: string; duration?: number; }[] = [];
		const original = HTMLMediaElement.prototype.play;
		HTMLMediaElement.prototype.play = async function (): Promise<void> {
			const bytes = new Uint8Array(await (await fetch(this.src)).arrayBuffer());
			const cue = { name: assets[btoa(String.fromCharCode(...bytes))], duration: undefined as number | undefined };
			cues.push(cue);
			await original.call(this);
			cue.duration = this.duration;
		};
		Object.assign(window, { ashTestOutcomeCues: cues, ashTestOutcomePlay: original });
	}, assets);
	const readCues = () => page.evaluate(() => (window as unknown as { ashTestOutcomeCues: { name: string; duration?: number; }[]; }).ashTestOutcomeCues);
	try {
		await workbench.settingsEditor.openUserSettingsUI();
		await workbench.settingsEditor.selectGroup('general');
		await workbench.settingsEditor.selectCategory('general');
		for (const name of ['taskCompleted', 'taskFailed', 'terminalCommandSucceeded', 'terminalCommandFailed']) {
			const sound = workbench.settingsEditor.element.locator(`[data-configuration-key="accessibility.signals.${name}"]`).getByRole('textbox', { name: 'Mode 1', exact: true });
			await sound.fill('on');
			await sound.press('Tab');
			await expect(sound).toBeEnabled();
		}
		await workbench.settingsEditor.element.locator('.ash-modal-editor-close').click();
		await workbench.quickaccess.runCommand('workbench.action.tasks.runTask');
		await workbench.quickaccess.select('Smoke build');
		await expect.poll(() => readFile(join(testWorkspace.directory, 'task-runs.txt'), 'utf8')).toBe('1');
		await expect.poll(async () => (await readCues()).filter(cue => cue.duration !== undefined).length).toBe(1);
		await workbench.quickaccess.runCommand('workbench.action.tasks.runTask');
		await workbench.quickaccess.select('Smoke fail');
		await page.getByRole('tab', { name: 'Tasks', exact: true }).click();
		await expect(page.locator('.ash-task-run').filter({ hasText: 'Smoke fail' })).toContainText('Smoke fail — failed (7)');
		await expect.poll(async () => (await readCues()).filter(cue => cue.duration !== undefined).length).toBe(2);
		const cues = await readCues();
		expect(cues.map(cue => cue.name)).toEqual(['success', 'error']);
		expect(cues.every(cue => cue.duration! > 0)).toBe(true);
	} finally {
		await page.evaluate(() => { HTMLMediaElement.prototype.play = (window as unknown as { ashTestOutcomePlay: typeof HTMLMediaElement.prototype.play; }).ashTestOutcomePlay; });
	}
});

test('task platform overrides resolve the execution host command, cwd and merged environment', async ({ workbench, testWorkspace }) => {
	const directory = testWorkspace.directory;
	const key = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
	await mkdir(join(directory, 'platform-work'), { recursive: true });
	await writeFile(join(directory, 'platform-run.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(join(directory, 'platform-result.json'))}, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), inherited: process.env.ASH_PLATFORM_INHERITED, selected: process.env.ASH_PLATFORM_SELECTED, removed: process.env.TERM_PROGRAM === undefined }));`);
	const platformBlocks = { windows: { command: 'wrong-windows-executable' }, osx: { command: 'wrong-mac-executable' }, linux: { command: 'wrong-linux-executable' } };
	await writeFile(join(directory, '.vscode', 'tasks.json'), JSON.stringify({
		version: '2.0.0', options: { env: { ASH_PLATFORM_INHERITED: 'document', ASH_PLATFORM_SELECTED: 'document' } },
		tasks: [{
			label: 'Platform smoke', type: 'process', command: 'wrong-base-executable', ...platformBlocks,
			options: { env: { ASH_PLATFORM_SELECTED: 'task' } },
			[key]: { command: process.execPath, args: ['${workspaceFolder}/platform-run.cjs', '', '${env:TERM_PROGRAM}', '$HOME'], options: { cwd: '${workspaceFolder}/platform-work', env: { ASH_PLATFORM_SELECTED: '${env:TERM_PROGRAM}', TERM_PROGRAM: null } } },
		}],
	}));
	await workbench.quickaccess.runCommand('workbench.action.tasks.runTask');
	await expect(workbench.quickaccess.items.filter({ hasText: 'Platform smoke' })).toBeVisible();
	await workbench.quickaccess.select('Platform smoke');
	await expect.poll(async () => { try { return JSON.parse(await readFile(join(directory, 'platform-result.json'), 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; } }).toEqual({ cwd: join(directory, 'platform-work'), args: ['', 'ash', '$HOME'], inherited: 'document', selected: 'ash', removed: true });
});

test('installed declarative extension matchers parse task diagnostics and retire when disabled', async ({ application, workbench, testWorkspace }) => {
	const directory = testWorkspace.directory;
	const root = join(directory, 'matcher-extension');
	await mkdir(join(root, '.ash-plugin'), { recursive: true });
	await mkdir(join(root, 'matcher'), { recursive: true });
	await writeFile(join(root, '.ash-plugin', 'plugin.json'), JSON.stringify({
		schemaVersion: 1, id: 'acme/matcher-smoke', version: '1.0.0', displayName: 'Matcher smoke', compatibility: { ash: '>=0.1.0' },
		contributions: { declarativeExtensions: [{ id: 'matcher', path: 'matcher' }] }, permissions: [{ type: 'directory', access: 'read' }],
	}));
	await writeFile(join(root, 'matcher', 'package.json'), JSON.stringify({
		name: 'matcher-smoke', publisher: 'acme', version: '1.0.0', contributes: {
			problemPatterns: [{ name: 'smoke-contributed-pattern', regexp: '^(.+):(\\d+):(\\d+) (.+)$', file: 1, line: 2, column: 3, message: 4 }],
			problemMatchers: [{ name: 'smoke-contributed-base', owner: 'smoke-contributed', pattern: '$smoke-contributed-pattern' }, { name: 'smoke-contributed', base: '$smoke-contributed-base', severity: 'warning' }],
		},
	}));
	await writeFile(join(directory, 'matcher-run.cjs'), "const fs = require('node:fs'); fs.writeFileSync('matcher-runs.txt', String(Number(fs.readFileSync('matcher-runs.txt', 'utf8')) + 1)); fs.writeFileSync('matcher-extension-path.txt', process.argv[2]); console.log('matcher-file.ts:2:3 Contributed matcher warning');");
	await writeFile(join(directory, 'matcher-runs.txt'), '0');
	await writeFile(join(directory, 'matcher-file.ts'), '\nlet marker = true;\n');
	await writeFile(join(directory, '.vscode', 'tasks.json'), JSON.stringify({ version: '2.0.0', tasks: [{ label: 'Matcher smoke', type: 'process', command: process.execPath, args: ['${workspaceFolder}/matcher-run.cjs', '${extensionInstallFolder:acme.matcher-smoke}'], problemMatcher: '$smoke-contributed' }] }));
	const page = workbench.page;
	await workbench.quickaccess.runCommand('ash.extensions.installLocal');
	const installation = page.getByRole('dialog', { name: 'Install extension from workspace', exact: true });
	await installation.getByRole('textbox').fill('matcher-extension');
	const installed = await workbench.dialogs.expectMessage(application, 'Information', () => installation.getByRole('textbox').press('Enter'));
	expect(installed.message).toContain('Installed acme/matcher-smoke 1.0.0');
	const manage = async (button: string): Promise<void> => {
		await workbench.dialogs.confirm(application, 'Matcher smoke', button, async () => {
			await workbench.quickaccess.runCommand('ash.extensions.manageLocal');
			await page.getByRole('option').filter({ has: page.getByText('Matcher smoke', { exact: true }) }).click();
		});
	};
	await manage('Enable');
	await manage('Grant permissions');
	await workbench.quickaccess.runCommand('workbench.action.tasks.runTask');
	await workbench.quickaccess.select('Matcher smoke');
	await expect.poll(() => readFile(join(directory, 'matcher-runs.txt'), 'utf8')).toBe('1');
	const problems = page.getByRole('tab', { name: 'Problems', exact: true });
	if (!await problems.isVisible()) await workbench.quickaccess.runCommand('workbench.action.togglePanel');
	await problems.click();
	await expect(page.locator('.ash-problems-results')).toContainText('Contributed matcher warning');
	const installedPath = await readFile(join(directory, 'matcher-extension-path.txt'), 'utf8');
	expect(installedPath.endsWith(join('matcher'))).toBe(true);
	expect(JSON.parse(await readFile(join(installedPath, 'package.json'), 'utf8')).name).toBe('matcher-smoke');
	await manage('Disable');
	await workbench.quickaccess.runCommand('workbench.action.tasks.runTask');
	await workbench.quickaccess.select('Matcher smoke');
	await expect(page.locator('.ash-notification-host')).toContainText("Unknown problem matcher '$smoke-contributed'");
	expect(await readFile(join(directory, 'matcher-runs.txt'), 'utf8')).toBe('1');
	await manage('Revoke permissions');
	await manage('Uninstall');
});


for (const locale of ['en', 'zh-CN']) {
	test(`unsupported task configuration shows a clear error without starting a process and can be corrected (${locale})`, async ({ workbench, testWorkspace, restartWorkbench }) => {
		if (locale === 'zh-CN') {
			await workbench.quickaccess.runCommand('workbench.action.configureLocale');
			const language = workbench.page.getByRole('dialog', { name: 'Select Display Language' }).getByRole('combobox');
			await language.fill('简体中文');
			await language.press('Enter');
			({ workbench } = await restartWorkbench());
		}
		// Opening the panel creates its interactive shell asynchronously. Establish
		// that baseline before checking that rejected tasks create no terminal.
		await workbench.quickaccess.runCommand('workbench.action.togglePanel');
		await expect(workbench.terminal.activeInstance).toBeVisible();
		const initialTerminalCount = await workbench.terminal.instances.count();
		const unsupportedMessage = locale === 'zh-CN' ? /任务“Smoke configured”尚未启动，因为 Ash 尚不支持：/u : /Task 'Smoke configured' was not started because Ash does not yet support:/;
		const configurationPath = join(testWorkspace.directory, '.vscode', 'tasks.json');
		await writeFile(configurationPath, JSON.stringify({
			version: '2.0.0', tasks: [
				{ label: 'Smoke configured', type: 'shell', command: 'node smoke-task.cjs', presentation: { group: 'parallel' }, options: { env: { MODE: 'test' } } },
			]
		}));
		await workbench.quickaccess.runCommand('workbench.action.tasks.runTask');
		await workbench.quickaccess.select('Smoke configured');
		await expect(workbench.page.locator('.ash-notification-host').getByText(unsupportedMessage)).toBeVisible();
		expect(await readFile(join(testWorkspace.directory, 'task-runs.txt'), 'utf8')).toBe('0');
		await expect(workbench.page.locator('.ash-task-run')).toHaveCount(0);
		await expect(workbench.terminal.instances).toHaveCount(initialTerminalCount);
		const tasksTab = workbench.page.getByRole('tab', { name: locale === 'zh-CN' ? '任务' : 'Tasks', exact: true });
		if (!await tasksTab.isVisible()) await workbench.quickaccess.runCommand('workbench.action.togglePanel');
		await tasksTab.click();
		await workbench.page.locator('.ash-tasks-run').filter({ hasText: 'Smoke configured' }).click();
		await expect(workbench.page.locator('.ash-tasks-status')).toContainText(unsupportedMessage);
		// Inactive panel views detach their widgets. Count terminal instances only
		// while Terminal is visible, so hiding its DOM cannot satisfy the assertion.
		await workbench.page.getByRole('tab', { name: locale === 'zh-CN' ? '终端' : 'Terminal', exact: true }).click();
		await expect(workbench.terminal.instances).toHaveCount(initialTerminalCount);
		expect(await readFile(join(testWorkspace.directory, 'task-runs.txt'), 'utf8')).toBe('0');
		await tasksTab.click();

		await writeFile(configurationPath, JSON.stringify({
			version: '2.0.0', tasks: [
				{ label: 'Smoke process', type: 'process', command: 'node', args: ['smoke-task.cjs'] },
			]
		}));
		await workbench.quickaccess.runCommand('workbench.action.tasks.runTask');
		await workbench.quickaccess.select('Smoke process');
		await expect.poll(() => readFile(join(testWorkspace.directory, 'task-runs.txt'), 'utf8')).toBe('1');
		await expect(workbench.terminal.instances).toHaveCount(initialTerminalCount + 1);
		await tasksTab.click();
		await expect(workbench.page.locator('.ash-task-run')).toContainText('Smoke process — succeeded (0)');

		await writeFile(configurationPath, JSON.stringify({
			version: '2.0.0', tasks: [
				{ label: 'Smoke configured', type: 'shell', command: 'node smoke-task.cjs', customMetadata: { providerVersion: 2 }, problemMatcher: [] },
			]
		}));
		// The fixture also contributes four Cargo tasks; correcting this task must keep those siblings.
		// File changes must clear the prior error before the user retries.
		await expect(workbench.page.locator('.ash-tasks-run').filter({ hasText: 'Smoke configured' })).toBeVisible();
		await expect(workbench.page.locator('.ash-tasks-status')).toHaveText('5 workspace tasks.');
		await expect(workbench.page.locator('.ash-task-label')).toHaveText(['cargo build', 'cargo check', 'cargo test', 'cargo run', 'Smoke configured']);
		await workbench.quickaccess.runCommand('workbench.action.tasks.runTask');
		await workbench.quickaccess.select('Smoke configured');
		await expect.poll(() => readFile(join(testWorkspace.directory, 'task-runs.txt'), 'utf8')).toBe('2');
		await expect(workbench.terminal.activeInstance).toContainText('ASH_TASK_RUN_2');
		await tasksTab.click();
		await expect(workbench.page.locator('.ash-tasks-status')).toHaveText('5 workspace tasks.');
		await expect(workbench.page.locator('.ash-task-run')).toContainText('Smoke configured — succeeded (0)');
		expect(await readFile(join(testWorkspace.directory, 'task-runs.txt'), 'utf8')).toBe('2');
	});
}

for (const reevaluate of [true, false]) {
	test(`configured task inputs cancel before execution and reevaluate ${reevaluate} on rerun`, async ({ workbench, testWorkspace }) => {
		const page = workbench.page;
		const directory = testWorkspace.directory;
		await writeFile(join(directory, 'smoke-input-task.cjs'), "require('node:fs').writeFileSync('task-inputs.json', JSON.stringify(process.argv.slice(2))); require('./smoke-task.cjs');\n");
		await writeFile(join(directory, '.vscode', 'tasks.json'), JSON.stringify({
			version: '2.0.0',
			inputs: [
				{ id: 'name', type: 'promptString', description: 'Task input name', default: 'initial', password: true },
				{ id: 'mode', type: 'pickString', description: 'Task build mode', options: ['debug', { label: 'Optimized', value: 'release' }], default: 'release' },
			],
			tasks: [{ label: 'Smoke inputs', type: 'shell', runOptions: { reevaluateOnRerun: reevaluate }, command: "node smoke-input-task.cjs '${input:name}' '${input:mode}' '${input:name}'" }],
		}));
		const initialTerminals = await workbench.terminal.instances.count();
		await workbench.quickaccess.runCommand('workbench.action.tasks.runTask');
		await workbench.quickaccess.select('Smoke inputs');
		const prompt = page.getByRole('dialog', { name: 'Task input name', exact: true }).getByLabel('Task input name', { exact: true });
		await expect(prompt).toBeFocused();
		await expect(prompt).toHaveValue('initial');
		await expect(prompt).toHaveAttribute('type', 'password');
		await prompt.press('Escape');
		await expect(prompt).not.toBeVisible();
		expect(await readFile(join(directory, 'task-runs.txt'), 'utf8')).toBe('0');
		await expect(workbench.terminal.instances).toHaveCount(initialTerminals);
		await expect(page.locator('.ash-notification-host').getByRole('alert')).toHaveCount(0);

		const tasksTab = page.getByRole('tab', { name: 'Tasks', exact: true });
		if (!await tasksTab.isVisible()) await workbench.quickaccess.runCommand('workbench.action.togglePanel');
		await tasksTab.click();
		await page.locator('.ash-tasks-run').filter({ hasText: 'Smoke inputs' }).click();
		await expect(prompt).toBeFocused();
		await prompt.press('Escape');
		await expect(page.locator('.ash-tasks-status')).not.toHaveClass(/error/);
		await expect(workbench.terminal.instances).toHaveCount(initialTerminals);

		await workbench.quickaccess.runCommand('workbench.action.tasks.runTask');
		await workbench.quickaccess.select('Smoke inputs');
		await prompt.fill('first');
		await prompt.press('Enter');
		const pick = page.getByRole('dialog', { name: 'Task build mode', exact: true }).getByRole('combobox', { name: 'Task build mode', exact: true });
		await expect(pick).toBeFocused();
		await pick.press('Enter');
		await expect.poll(() => readFile(join(directory, 'task-runs.txt'), 'utf8')).toBe('1');
		expect(JSON.parse(await readFile(join(directory, 'task-inputs.json'), 'utf8'))).toEqual(['first', 'release', 'first']);
		await tasksTab.click();
		await expect(page.locator('.ash-task-run')).toContainText('Smoke inputs — succeeded (0)');

		await workbench.quickaccess.runCommand('workbench.action.tasks.reRunTask');
		if (reevaluate) {
			await expect(prompt).toHaveValue('initial');
			await prompt.fill('second');
			await prompt.press('Enter');
			await pick.fill('debug');
			await pick.press('Enter');
			await expect.poll(() => readFile(join(directory, 'task-runs.txt'), 'utf8')).toBe('2');
			expect(JSON.parse(await readFile(join(directory, 'task-inputs.json'), 'utf8'))).toEqual(['second', 'debug', 'second']);
		} else {
			await expect.poll(() => readFile(join(directory, 'task-runs.txt'), 'utf8')).toBe('2');
			expect(JSON.parse(await readFile(join(directory, 'task-inputs.json'), 'utf8'))).toEqual(['first', 'release', 'first']);
			await expect(prompt).not.toBeVisible();
			await expect(pick).not.toBeVisible();
		}
	});
}


test('task command resolves environment values from the execution host', async ({ workbench, testWorkspace }) => {
	await workbench.quickaccess.runCommand('workbench.action.tasks.runTask');
	await workbench.quickaccess.select('Smoke environment');
	await expect.poll(async () => JSON.parse(await readFile(join(testWorkspace.directory, 'task-environment.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return 'null'; throw error; }))).toEqual({ args: ['ash', ''], value: 'task value', folder: testWorkspace.directory, keyed: 'resolved key', removed: true });
});

test('task execution resolves host paths and current settings through the shared variable owner', async ({ application, workbench, testWorkspace, webAppServer }) => {
	const directory = testWorkspace.directory;
	const home = webAppServer?.profileDirectory ?? ('windows' in application ? await application.evaluate(() => process.env.HOME!) : undefined);
	expect(home).toBeTruthy();
	await writeFile(join(directory, 'variable-run.cjs'), "require('node:fs').writeFileSync('variable-result.json', JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));");
	await writeFile(join(directory, '.vscode', 'tasks.json'), JSON.stringify({ version: '2.0.0', tasks: [{ label: 'Variable smoke', type: 'process', command: process.execPath, args: ['${cwd}${/}variable-run.cjs', '${workspaceFolder}', '${config:editor.fontSize}', '${userHome}', '${pathSeparator}', '${/}'], options: { cwd: '${cwd}' } }] }));
	await workbench.settingsEditor.openUserSettingsUI();
	await workbench.settingsEditor.selectEditorCategory('editor-fonts');
	const settings = workbench.settingsEditor.element;
	await settings.locator('[data-configuration-key="editor.fontSize"]').fill('18');
	await settings.locator('[data-configuration-key="editor.fontSize"]').press('Tab');
	await settings.locator('.ash-modal-editor-close').click();
	await workbench.quickaccess.runCommand('workbench.action.tasks.runTask');
	await workbench.quickaccess.select('Variable smoke');
	await expect.poll(async () => { try { return JSON.parse(await readFile(join(directory, 'variable-result.json'), 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; } }).toEqual({ args: [directory, '18', home, sep, sep], cwd: directory });
});

test('Tasks resolve active file and selection variables before process execution without expanding selected text', async ({ workbench, testWorkspace }) => {
	const directory = testWorkspace.directory;
	const selected = 'chosen $HOME ${env:SHOULD_STAY_LITERAL}';
	await mkdir(join(directory, 'variable-source'));
	await writeFile(join(directory, 'variable-source', 'editor-variable.ts'), `first line\n${selected}\n`);
	await writeFile(join(directory, 'editor-variable-run.cjs'), "require('node:fs').writeFileSync('editor-variable-result.json', JSON.stringify(process.argv.slice(2)));");
	const references = ['file', 'fileDirname', 'fileDirnameBasename', 'fileBasename', 'fileBasenameNoExtension', 'fileExtname', 'fileWorkspaceFolder', 'fileWorkspaceFolderBasename', 'relativeFile', 'relativeFileDirname', 'selectedText', 'lineNumber', 'columnNumber'];
	await writeFile(join(directory, '.vscode', 'tasks.json'), JSON.stringify({ version: '2.0.0', tasks: [{ label: 'Editor variable smoke', type: 'process', command: process.execPath, args: ['${workspaceFolder}/editor-variable-run.cjs', ...references.map(name => '${' + name + '}')] }] }));
	await workbench.quickaccess.open('editor-variable.ts');
	await workbench.quickaccess.select('editor-variable.ts');
	const editor = workbench.editors.groupAt(0).editor;
	await editor.waitForEditorContents(text => text.includes(selected));
	await editor.waitForEditorFocus();
	await workbench.page.keyboard.press('ControlOrMeta+Home');
	await workbench.page.keyboard.press('ArrowDown');
	await workbench.page.keyboard.press('Home');
	await workbench.page.keyboard.press('Shift+End');
	await workbench.quickaccess.runCommand('workbench.action.tasks.runTask');
	await workbench.quickaccess.select('Editor variable smoke');
	await expect.poll(async () => { try { return JSON.parse(await readFile(join(directory, 'editor-variable-result.json'), 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; } }).toEqual([
		join(directory, 'variable-source', 'editor-variable.ts'), join(directory, 'variable-source'), 'variable-source', 'editor-variable.ts', 'editor-variable', '.ts', directory, basename(directory), join('variable-source', 'editor-variable.ts'), 'variable-source', selected, '2', String(selected.length + 1),
	]);
});

test('shell tasks quote resolved arguments and honor explicit shell selection without changing raw command lines', async ({ workbench, testWorkspace }) => {
	test.skip(process.platform === 'win32', 'Exercises POSIX quoting and an explicit /bin/sh executable.');
	const directory = testWorkspace.directory;
	const script = join(directory, 'shell task.cjs');
	await writeFile(script, "require('node:fs').writeFileSync(process.argv[2], JSON.stringify({args: process.argv.slice(3), mode: process.env.ASH_SHELL_MODE, cwd: process.cwd()}));\n");
	const args = [
		'${workspaceFolder}/shell task.cjs', '', '',
		{ value: '$HOME', quoting: 'strong' },
		{ value: '$ASH_SHELL_MODE', quoting: 'weak' },
		{ value: 'two words', quoting: 'escape' },
		{ value: "one'two", quoting: 'strong' },
		{ value: '$(touch injected)', quoting: 'strong' },
	];
	await writeFile(join(directory, '.vscode', 'tasks.json'), JSON.stringify({
		version: '2.0.0', tasks: [
			{ label: 'Default shell arguments', type: 'shell', command: process.execPath, args: [args[0], '${workspaceFolder}/default-shell.json', ...args.slice(2)], options: { env: { ASH_SHELL_MODE: 'two words $(touch not-evaluated)' } } },
			{ label: 'Explicit shell arguments', type: 'shell', command: { value: process.execPath, quoting: 'strong' }, args: [args[0], '${workspaceFolder}/explicit-shell.json', ...args.slice(2)], options: { shell: { executable: '/bin/sh', args: ['-c'] }, cwd: '${workspaceFolder}', env: { ASH_SHELL_MODE: 'two words $(touch not-evaluated)' } } },
		]
	}));
	for (const [label, result] of [['Default shell arguments', 'default-shell.json'], ['Explicit shell arguments', 'explicit-shell.json']]) {
		await workbench.quickaccess.runCommand('workbench.action.tasks.runTask');
		await workbench.quickaccess.select(label);
		await expect.poll(async () => JSON.parse(await readFile(join(directory, result), 'utf8').catch(error => { if (error.code === 'ENOENT') return 'null'; throw error; }))).toEqual({
			args: ['', '$HOME', 'two words $(touch not-evaluated)', 'two words', "one'two", '$(touch injected)'], mode: 'two words $(touch not-evaluated)', cwd: directory,
		});
	}
	for (const file of ['injected', 'not-evaluated']) {
		expect(await readFile(join(directory, file), 'utf8').then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })).toBe(false);
	}
	// A full command line continues to be interpreted by its shell.
	await writeFile(join(directory, '.vscode', 'tasks.json'), JSON.stringify({ version: '2.0.0', tasks: [{ label: 'Raw shell command', type: 'shell', command: 'printf raw > raw-shell.txt' }] }));
	await workbench.quickaccess.runCommand('workbench.action.tasks.runTask');
	await workbench.quickaccess.select('Raw shell command');
	await expect.poll(() => readFile(join(directory, 'raw-shell.txt'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; })).toBe('raw');
});

test('process task dependencies wait for background diagnostics and preserve cwd and literal argv', async ({ workbench, testWorkspace }) => {
	const directory = testWorkspace.directory;
	await mkdir(join(directory, 'child'));
	await writeFile(join(directory, 'compile-watch.cjs'), "const fs = require('node:fs'); const path = require('node:path'); const root = process.argv[2]; fs.writeFileSync(path.join(root, 'compiler-pid.txt'), String(process.pid)); console.log('BUILD'); console.log('ASH_COMPILER_WAITING'); const timer = setInterval(() => { if (fs.existsSync(path.join(root, 'release-compiler'))) { clearInterval(timer); console.log('file.ts(2,3): warning TS1000: Smoke compiler warning'); console.log('READY'); setInterval(() => {}, 1000); } }, 40);\n");
	await writeFile(join(directory, 'process-result.cjs'), "require('node:fs').writeFileSync(process.argv[2], JSON.stringify({cwd: process.cwd(), args: process.argv.slice(3), mode: process.env.ASH_PROCESS_MODE}));\n");
	await writeFile(join(directory, '.vscode', 'tasks.json'), JSON.stringify({
		version: '2.0.0', tasks: [
			{ label: 'Compiler watch', type: 'process', command: process.execPath, args: [join(directory, 'compile-watch.cjs'), directory], isBackground: true, problemMatcher: { base: '$tsc', background: { activeOnStart: true, beginsPattern: '^BUILD$', endsPattern: '^READY$' } } },
			{ label: 'Process with dependency', type: 'process', command: process.execPath, args: [join(directory, 'process-result.cjs'), join(directory, 'process-result.json'), '', 'two words', '$HOME', '$(touch injected)'], options: { cwd: '${workspaceFolder}/child', env: { ASH_PROCESS_MODE: 'resolved ${env:TERM_PROGRAM}' } }, dependsOn: 'Compiler watch' },
		]
	}));
	await workbench.quickaccess.runCommand('workbench.action.tasks.runTask');
	await workbench.quickaccess.select('Process with dependency');
	await workbench.quickaccess.runCommand('workbench.action.togglePanel');
	await workbench.page.getByRole('tab', { name: 'Terminal', exact: true }).click();
	await expect(workbench.terminal.activeInstance).toContainText('ASH_COMPILER_WAITING');
	await expect.poll(() => readFile(join(directory, 'process-result.json'), 'utf8').then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })).toBe(false);
	await writeFile(join(directory, 'release-compiler'), 'ready');
	await expect.poll(async () => JSON.parse(await readFile(join(directory, 'process-result.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return 'null'; throw error; }))).toEqual({ cwd: join(directory, 'child'), args: ['', 'two words', '$HOME', '$(touch injected)'], mode: 'resolved ash' });
	await workbench.page.getByRole('tab', { name: 'Problems', exact: true }).click();
	await expect(workbench.page.locator('.ash-problems-results')).toContainText('Smoke compiler warning');
	await workbench.quickaccess.runCommand('workbench.action.tasks.terminate');
	const pid = Number(await readFile(join(directory, 'compiler-pid.txt'), 'utf8'));
	await expect.poll(() => { try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; } }).toBe(false);
});

test('first task discovery activates an installed dormant provider and disable retires its process tasks', async ({ application, workbench, testWorkspace }) => {
	test.skip(process.platform !== 'darwin', 'Requires the product JS confinement launcher.');
	test.setTimeout(90_000);
	const directory = testWorkspace.directory;
	const root = join(directory, 'task-extension');
	await mkdir(join(root, '.ash-plugin'), { recursive: true });
	await writeFile(join(root, '.ash-plugin', 'plugin.json'), JSON.stringify({
		schemaVersion: 1, id: 'acme/lazy-task-smoke', version: '1.0.0', displayName: 'Lazy task smoke', compatibility: { ash: '>=0.1.0' },
		contributions: { editorExtensions: [{ id: 'tasks', runtime: 'javascript', entrypoint: 'extension.js', runtimeApiVersion: 1, activationEvents: [{ type: 'onTaskType', taskType: 'lazy-build' }], capabilities: ['taskProvider', 'command'] }] },
		permissions: [{ type: 'directory', access: 'read' }],
	}));
	const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
	const taskDocument = JSON.parse(await readFile(join(directory, '.vscode', 'tasks.json'), 'utf8'));
	await writeFile(join(directory, '.vscode', 'tasks.json'), JSON.stringify({ ...taskDocument, [platform]: { group: 'build' }, tasks: [...taskDocument.tasks, { label: 'Configured platform build', type: 'lazy-build', target: 'configured' }] }));
	await writeFile(join(directory, 'lazy-task-runs.txt'), '0');
	await writeFile(join(directory, 'lazy-task-run.cjs'), "const fs = require('node:fs'); const count = Number(fs.readFileSync('lazy-task-runs.txt', 'utf8')) + 1; fs.writeFileSync('lazy-task-runs.txt', String(count)); console.log('LAZY_TASK_RUN_' + count);");
	await writeFile(join(root, 'extension.js'), `import { tasks } from '@ash/extension';
export function activate(context) {
	context.subscriptions.push(tasks.registerTaskProvider('build', 'lazy-build', {
		resolveTask(invocation, task) {
			return {
				id: 'resolved', label: task.label, group: 'test', groupIsDefault: true,
				definition: task.definition, cwd: ${JSON.stringify(directory)},
				execution: { type: 'process', program: ${JSON.stringify(process.execPath)}, args: [${JSON.stringify(join(directory, 'lazy-task-run.cjs'))}] }
			};
		},
		provideTasks() { return [{ id: 'build', label: 'Lazy provider build', group: 'build', definition: { type: 'lazy-build' }, presentation: { panel: 'dedicated', clear: true }, cwd: ${JSON.stringify(directory)} }]; }
	}), tasks.registerTaskEvents('configured-group', async (invocation, event) => {
		if (event.type !== 'start') return;
		if (event.execution.task.name === 'Lazy provider build') {
			if (event.execution.task.group !== 'build' || event.execution.task.groupIsDefault !== undefined) throw Error('Provided group lost precedence');
			await invocation.window.showInformationMessage('PROVIDED_GROUP_RETAINED');
			return;
		}
		if (event.execution.task.name !== 'Configured platform build') return;
		if (event.execution.task.group !== 'build' || event.execution.task.groupIsDefault !== undefined) throw Error('Configured platform group lost precedence');
		await invocation.window.showInformationMessage('CONFIGURED_PLATFORM_GROUP_RETAINED');
	}));
}`);
	const page = workbench.page;
	await workbench.quickaccess.runCommand('ash.extensions.installLocal');
	const installation = page.getByRole('dialog', { name: 'Install extension from workspace', exact: true });
	await installation.getByRole('textbox').fill('task-extension');
	const installed = await workbench.dialogs.expectMessage(application, 'Information', () => installation.getByRole('textbox').press('Enter'));
	expect(installed.message).toContain('Installed acme/lazy-task-smoke 1.0.0');
	const manage = async (button: string): Promise<void> => {
		await workbench.dialogs.confirm(application, 'Lazy task smoke', button, async () => {
			await workbench.quickaccess.runCommand('ash.extensions.manageLocal');
			await page.getByRole('option').filter({ has: page.getByText('Lazy task smoke', { exact: true }) }).click();
		});
	};
	await manage('Enable');
	await manage('Grant permissions');
	await workbench.quickaccess.runCommand('workbench.action.tasks.runTask');
	await expect(workbench.quickaccess.items.filter({ hasText: 'Lazy provider build' })).toBeVisible();
	expect(await readFile(join(directory, 'lazy-task-runs.txt'), 'utf8')).toBe('0');
	await workbench.quickaccess.select('Lazy provider build');
	await expect.poll(() => readFile(join(directory, 'lazy-task-runs.txt'), 'utf8')).toBe('1');
	await expect(page.locator('.ash-notification', { hasText: 'PROVIDED_GROUP_RETAINED' })).toBeVisible();
	await expect(workbench.terminal.activeInstance).toContainText('LAZY_TASK_RUN_1');
	await expect(page.locator('.ash-terminal-tabs [role="tab"][aria-selected="true"]').locator('..')).toHaveAttribute('data-state', 'exited');
	const screen = await workbench.terminal.activeInstance.elementHandle();
	expect(screen).not.toBeNull();
	await workbench.quickaccess.runCommand('workbench.action.tasks.runTask');
	await workbench.quickaccess.select('Lazy provider build');
	await expect(workbench.terminal.activeInstance).toContainText('LAZY_TASK_RUN_2');
	await expect(workbench.terminal.activeInstance).not.toContainText('LAZY_TASK_RUN_1');
	expect(await screen!.evaluate(element => element === document.querySelector('.ash-terminal-instance:not([hidden])'))).toBe(true);
	await screen!.dispose();
	await workbench.quickaccess.runCommand('workbench.action.tasks.build');
	await workbench.quickaccess.select('Configured platform build');
	await expect(page.locator('.ash-notification', { hasText: 'CONFIGURED_PLATFORM_GROUP_RETAINED' })).toBeVisible();
	await expect.poll(() => readFile(join(directory, 'lazy-task-runs.txt'), 'utf8')).toBe('3');
	await expect(workbench.terminal.activeInstance).toContainText('LAZY_TASK_RUN_3');
	await manage('Disable');
	await workbench.quickaccess.runCommand('workbench.action.tasks.runTask');
	await expect(workbench.quickaccess.items.filter({ hasText: 'Smoke build' })).toBeVisible();
	await expect(workbench.quickaccess.items.filter({ hasText: 'Lazy provider build' })).toHaveCount(0);
	await page.keyboard.press('Escape');
	expect(await readFile(join(directory, 'lazy-task-runs.txt'), 'utf8')).toBe('3');
	await manage('Revoke permissions');
	await manage('Uninstall');
});

test('a standard command-only extension starts the built-in build Task and receives a void result', async ({ application, workbench, testWorkspace }) => {
	test.skip(process.platform !== 'darwin', 'Requires the product JS confinement launcher.');
	const directory = testWorkspace.directory;
	const root = join(directory, 'command-task-extension');
	await mkdir(join(root, '.ash-plugin'), { recursive: true });
	await writeFile(join(root, '.ash-plugin', 'plugin.json'), JSON.stringify({ schemaVersion: 1, id: 'acme/command-task-smoke', version: '1.0.0', displayName: 'Command task smoke', compatibility: { ash: '>=0.1.0' }, contributions: { editorExtensions: [{ id: 'commands', runtime: 'javascript', api: 'vscode', entrypoint: 'extension.cjs', runtimeApiVersion: 1, activationEvents: [{ type: 'onCommand', id: 'acme.commandTask.build' }], capabilities: ['command'] }] }, permissions: [{ type: 'directory', access: 'read' }] }));
	await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'command-task', publisher: 'acme', version: '1.0.0', engines: { vscode: '^1.95.0' }, main: './extension.cjs', contributes: { commands: [{ command: 'acme.commandTask.build', title: 'Build through standard command API' }] } }));
	await writeFile(join(root, 'extension.cjs'), `const v = require('vscode');
exports.activate = context => context.subscriptions.push(v.commands.registerCommand('acme.commandTask.build', async () => {
	const result = await v.commands.executeCommand('workbench.action.tasks.build');
	if (result !== undefined) throw Error('Void command result changed');
	await v.window.showInformationMessage('STANDARD_TASK_COMMAND_RETURNED_VOID');
}));`);
	await writeFile(join(directory, '.vscode', 'tasks.json'), JSON.stringify({ version: '2.0.0', tasks: [{ label: 'Command API build', type: 'process', command: process.execPath, args: ['${workspaceFolder}/smoke-task.cjs'], group: { kind: 'build', isDefault: true }, presentation: { echo: false } }] }));
	const page = workbench.page;
	await workbench.quickaccess.runCommand('ash.extensions.installLocal');
	const installation = page.getByRole('dialog', { name: 'Install extension from workspace', exact: true });
	await installation.getByRole('textbox').fill('command-task-extension');
	const installed = await workbench.dialogs.expectMessage(application, 'Information', () => installation.getByRole('textbox').press('Enter'));
	expect(installed.message).toContain('Installed acme/command-task-smoke 1.0.0');
	const manage = async (button: string): Promise<void> => {
		await workbench.dialogs.confirm(application, 'Command task smoke', button, async () => {
			await workbench.quickaccess.runCommand('ash.extensions.manageLocal');
			await page.getByRole('option').filter({ has: page.getByText('Command task smoke', { exact: true }) }).click();
		});
	};
	await manage('Enable');
	await manage('Grant permissions');
	await workbench.quickaccess.runCommand('acme.commandTask.build');
	await expect(page.locator('.ash-notification', { hasText: 'STANDARD_TASK_COMMAND_RETURNED_VOID' })).toBeVisible();
	await expect.poll(() => readFile(join(directory, 'task-runs.txt'), 'utf8')).toBe('1');
	await expect(workbench.terminal.activeInstance).toContainText('ASH_TASK_RUN_1');
	await expect(page.locator('.ash-terminal-tabs [role="tab"][aria-selected="true"]').locator('..')).toHaveAttribute('data-state', 'exited');
	await manage('Disable');
	await manage('Revoke permissions');
	await manage('Uninstall');
});

test('standard Task command variables receive variable arrays once per process and shell run and cancel before execution', async ({ application, workbench, testWorkspace }) => {
	test.skip(process.platform !== 'darwin', 'Requires the product JS confinement launcher.');
	const directory = testWorkspace.directory;
	const root = join(directory, 'task-variable-map-extension');
	await mkdir(join(root, '.ash-plugin'), { recursive: true });
	await writeFile(join(root, '.ash-plugin', 'plugin.json'), JSON.stringify({ schemaVersion: 1, id: 'acme/task-variable-map-smoke', version: '1.0.0', displayName: 'Task variable map smoke', compatibility: { ash: '>=0.1.0' }, contributions: { editorExtensions: [{ id: 'commands', runtime: 'javascript', api: 'vscode', entrypoint: 'extension.cjs', runtimeApiVersion: 1, activationEvents: ['acme.taskVariables.pick', 'acme.taskVariables.report'].map(id => ({ type: 'onCommand', id })), capabilities: ['command'] }] }, permissions: [{ type: 'directory', access: 'read' }] }));
	await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'task-variable-map', publisher: 'acme', version: '1.0.0', engines: { vscode: '^1.95.0' }, main: './extension.cjs', contributes: { commands: [{ command: 'acme.taskVariables.pick', title: 'Pick Task argument' }, { command: 'acme.taskVariables.report', title: 'Report Task variable calls' }] } }));
	await writeFile(join(root, 'extension.cjs'), `const v = require('vscode'); let calls = 0;
exports.activate = context => context.subscriptions.push(
  v.commands.registerCommand('acme.taskVariables.pick', async vars => {
    if (!Array.isArray(vars) || vars.length !== 2 || vars[0] !== ${JSON.stringify(directory)} || vars[1] !== '\${command:acme.taskVariables.pick}') throw Error('Task command arguments differ from the variable array');
    calls++;
    if (calls === 3) { await v.window.showInformationMessage('TASK_VARIABLE_PICK_CANCELED'); return undefined; }
    return 'picked-' + calls + ' literal value';
  }),
  v.commands.registerCommand('acme.taskVariables.report', () => v.window.showInformationMessage('TASK_VARIABLE_CALLS_' + calls))
);`);
	await writeFile(join(directory, 'task-variable-args.jsonl'), '');
	await writeFile(join(directory, 'task-variables.cjs'), `require('node:fs').appendFileSync(${JSON.stringify(join(directory, 'task-variable-args.jsonl'))}, JSON.stringify(process.argv.slice(2)) + '\\n');`);
	await writeFile(join(directory, '.vscode', 'tasks.json'), JSON.stringify({ version: '2.0.0', tasks: ['process', 'shell'].map(type => ({ label: 'Variable ' + type, type, command: process.execPath, args: ['${workspaceFolder}/task-variables.cjs', '${command:acme.taskVariables.pick}', '${command:acme.taskVariables.pick}'], presentation: { echo: false, panel: 'dedicated' } })) }));
	const page = workbench.page;
	await workbench.quickaccess.runCommand('ash.extensions.installLocal');
	const installation = page.getByRole('dialog', { name: 'Install extension from workspace', exact: true });
	await installation.getByRole('textbox').fill('task-variable-map-extension');
	const installed = await workbench.dialogs.expectMessage(application, 'Information', () => installation.getByRole('textbox').press('Enter'));
	expect(installed.message).toContain('Installed acme/task-variable-map-smoke 1.0.0');
	const manage = async (button: string): Promise<void> => {
		await workbench.dialogs.confirm(application, 'Task variable map smoke', button, async () => {
			await workbench.quickaccess.runCommand('ash.extensions.manageLocal');
			await page.getByRole('option').filter({ has: page.getByText('Task variable map smoke', { exact: true }) }).click();
		});
	};
	await manage('Enable');
	await manage('Grant permissions');
	for (const type of ['process', 'shell']) {
		await workbench.quickaccess.runCommand('workbench.action.tasks.runTask');
		await workbench.quickaccess.select('Variable ' + type);
		await expect.poll(async () => (await readFile(join(directory, 'task-variable-args.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).length).toBe(type === 'process' ? 1 : 2);
		await expect(page.locator('.ash-terminal-tabs [role="tab"][aria-selected="true"]').locator('..')).toHaveAttribute('data-state', 'exited');
	}
	const expected = [['picked-1 literal value', 'picked-1 literal value'], ['picked-2 literal value', 'picked-2 literal value']];
	const readArgs = async () => (await readFile(join(directory, 'task-variable-args.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
	expect(await readArgs()).toEqual(expected);
	const terminals = await workbench.terminal.instances.count();
	await workbench.quickaccess.runCommand('workbench.action.tasks.runTask');
	await workbench.quickaccess.select('Variable process');
	await expect(page.locator('.ash-notification', { hasText: 'TASK_VARIABLE_PICK_CANCELED' })).toBeVisible();
	await workbench.quickaccess.runCommand('acme.taskVariables.report');
	await expect(page.locator('.ash-notification', { hasText: 'TASK_VARIABLE_CALLS_3' })).toBeVisible();
	expect(await readArgs()).toEqual(expected);
	await expect(workbench.terminal.instances).toHaveCount(terminals);
	await manage('Disable');
	await manage('Revoke permissions');
	await manage('Uninstall');
});

test('a standard CommonJS extension preserves configured problem reveal after repeated fetched Task edits', async ({ application, workbench, testWorkspace }) => {
	test.skip(process.platform !== 'darwin', 'Requires the product JS confinement launcher.');
	const directory = testWorkspace.directory;
	const root = join(directory, 'fetched-task-extension');
	await mkdir(join(root, '.ash-plugin'), { recursive: true });
	await writeFile(join(root, '.ash-plugin', 'plugin.json'), JSON.stringify({ schemaVersion: 1, id: 'acme/fetched-task-smoke', version: '1.0.0', displayName: 'Fetched task smoke', compatibility: { ash: '>=0.1.0' }, contributions: { editorExtensions: [{ id: 'tasks', runtime: 'javascript', api: 'vscode', entrypoint: 'extension.cjs', runtimeApiVersion: 1, activationEvents: [{ type: 'onCommand', id: 'acme.fetchedTask.edit' }], capabilities: ['command', 'taskProvider'] }] }, permissions: [{ type: 'directory', access: 'read' }] }));
	await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fetched-task', publisher: 'acme', version: '1.0.0', engines: { vscode: '^1.95.0' }, main: './extension.cjs', activationEvents: ['onCommand:acme.fetchedTask.edit'], contributes: { commands: [{ command: 'acme.fetchedTask.edit', title: 'Edit fetched Task' }], taskDefinitions: [{ type: 'fetched-task', required: [], properties: {} }], configuration: { properties: { 'fetchedTask.argument': { type: 'string', default: 'EXTENSION_DEFAULT' } } }, problemMatchers: [{ name: 'fetched-edit', owner: 'fetched-edit', pattern: { regexp: '^(.+)\\((\\d+),(\\d+)\\): (warning|error) TS([^:]+): (.*)$', file: 1, line: 2, column: 3, severity: 4, code: 5, message: 6 } }] } }));
	await writeFile(join(root, 'extension.cjs'), `const v = require('vscode');
let task; let edits = 0;
exports.activate = context => context.subscriptions.push(v.commands.registerCommand('acme.fetchedTask.edit', async () => {
	task ??= (await v.tasks.fetchTasks()).find(value => value.name === 'Configured edited task');
	if (!task || 'revealProblems' in task.presentationOptions) throw Error('Invalid public Task snapshot');
	task.name = 'Edited task ' + ++edits;
	task.execution.args = [${JSON.stringify(join(directory, 'fetched-task.cjs'))}, 'TASK_EDITED_' + edits, '$HOME', '', '\${config:fetchedTask.argument}'];
	task.presentationOptions = {reveal: v.TaskRevealKind.Never, panel: v.TaskPanelKind.Dedicated, clear: true, echo: false};
	const execution = await v.tasks.executeTask(task);
	if (execution.task !== task) throw Error('Edited Task identity changed');
	await v.window.showInformationMessage('EDITED_TASK_STARTED_' + edits);
}));`);
	await writeFile(join(directory, 'main.ts'), '\nlet diagnostic = true;\n');
	await writeFile(join(directory, 'fetched-runs.jsonl'), '');
	await writeFile(join(directory, 'fetched-task.cjs'), "require('node:fs').appendFileSync('fetched-runs.jsonl', JSON.stringify(process.argv.slice(2)) + '\\n'); console.log('main.ts(2,3): warning TS456: FETCHED_EDITED_DIAGNOSTIC');");
	await writeFile(join(directory, '.vscode', 'tasks.json'), JSON.stringify({ version: '2.0.0', tasks: [{ label: 'Configured edited task', type: 'process', command: process.execPath, args: ['${workspaceFolder}/fetched-task.cjs'], problemMatcher: '$fetched-edit', presentation: { reveal: 'never', revealProblems: 'onProblem' } }] }));
	const page = workbench.page;
	await workbench.quickaccess.runCommand('ash.extensions.installLocal');
	const installation = page.getByRole('dialog', { name: 'Install extension from workspace', exact: true });
	await installation.getByRole('textbox').fill('fetched-task-extension');
	const installed = await workbench.dialogs.expectMessage(application, 'Information', () => installation.getByRole('textbox').press('Enter'));
	expect(installed.message).toContain('Installed acme/fetched-task-smoke 1.0.0');
	const manage = async (button: string): Promise<void> => {
		await workbench.dialogs.confirm(application, 'Fetched task smoke', button, async () => {
			await workbench.quickaccess.runCommand('ash.extensions.manageLocal');
			await page.getByRole('option').filter({ has: page.getByText('Fetched task smoke', { exact: true }) }).click();
		});
	};
	await manage('Enable');
	await manage('Grant permissions');
	for (const edits of [1, 2]) {
		if (edits === 2) {
			await workbench.quickaccess.runCommand('workbench.action.openSettingsJson');
			const editor = workbench.editors.groupAt(0);
			await editor.editor.input.press('ControlOrMeta+A');
			await editor.editor.input.evaluate(element => {
				const clipboardData = new DataTransfer();
				clipboardData.setData('text/plain', '{"fetchedTask.argument":"USER_SETTING"}');
				element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
			});
			await editor.editor.input.press('ControlOrMeta+S');
			await expect(editor.tabs.filter({ hasText: 'User Settings (JSON)' }).locator('..')).not.toHaveAttribute('data-state', /dirty|conflict/u);
		}
		await workbench.quickaccess.runCommand('acme.fetchedTask.edit');
		await expect(page.locator('.ash-notification', { hasText: `EDITED_TASK_STARTED_${edits}` })).toBeVisible();
		await expect(page.locator('.ash-problems-results')).toBeVisible();
		await expect(page.locator('.ash-problems-results')).toContainText('FETCHED_EDITED_DIAGNOSTIC');
		await expect.poll(async () => (await readFile(join(directory, 'fetched-runs.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))).toEqual(Array.from({ length: edits }, (_, index) => [`TASK_EDITED_${index + 1}`, '$HOME', '', index === 0 ? 'EXTENSION_DEFAULT' : 'USER_SETTING']));
		await workbench.quickaccess.runCommand('workbench.action.terminal.focus');
		await expect(page.locator('.ash-terminal-tabs [role="tab"][aria-selected="true"]').locator('..')).toHaveAttribute('data-state', 'exited');
		await workbench.quickaccess.runCommand('workbench.action.togglePanel');
	}
	await manage('Disable');
	await workbench.quickaccess.runCommand('workbench.action.tasks.runTask');
	await workbench.quickaccess.select('Configured edited task');
	await expect(page.locator('.ash-notification-host')).toContainText("Unknown problem matcher '$fetched-edit'");
	expect((await readFile(join(directory, 'fetched-runs.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(2);
	await writeFile(join(directory, '.vscode', 'tasks.json'), JSON.stringify({ version: '2.0.0', tasks: [{ label: 'After configuration withdrawal', type: 'process', command: process.execPath, args: ['${workspaceFolder}/fetched-task.cjs', '${config:fetchedTask.argument}'] }] }));
	await workbench.quickaccess.runCommand('workbench.action.tasks.runTask');
	await workbench.quickaccess.select('After configuration withdrawal');
	await expect(page.locator('.ash-notification-host')).toContainText("Cannot resolve configuration 'fetchedTask.argument'");
	expect((await readFile(join(directory, 'fetched-runs.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(2);

	await manage('Revoke permissions');
	await manage('Uninstall');
});


test('a standard extension edits and copies fetched CustomExecution while releasing the original provider PTY', async ({ application, workbench, testWorkspace }) => {
	test.skip(process.platform !== 'darwin', 'Requires the product JS confinement launcher.');
	test.setTimeout(90_000);
	const directory = testWorkspace.directory;
	const root = join(directory, 'fetched-custom-extension');
	await mkdir(join(root, '.ash-plugin'), { recursive: true });
	await writeFile(join(root, '.ash-plugin', 'plugin.json'), JSON.stringify({ schemaVersion: 1, id: 'acme/fetched-custom-smoke', version: '1.0.0', displayName: 'Fetched custom smoke', compatibility: { ash: '>=0.1.0' }, contributions: { editorExtensions: [{ id: 'tasks', runtime: 'javascript', api: 'vscode', entrypoint: 'extension.cjs', runtimeApiVersion: 1, activationEvents: [{ type: 'onCommand', id: 'acme.fetchedCustom.edit' }], capabilities: ['command', 'taskProvider'] }] }, permissions: [{ type: 'directory', access: 'read' }] }));
	await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fetched-custom', publisher: 'acme', version: '1.0.0', engines: { vscode: '^1.95.0' }, main: './extension.cjs', contributes: { commands: [{ command: 'acme.fetchedCustom.edit', title: 'Edit fetched CustomExecution' }, { command: 'acme.fetchedCustom.stop', title: 'Stop edited CustomExecution' }], taskDefinitions: [{ type: 'fetched-custom', required: [], properties: {} }] } }));
	await writeFile(join(root, 'extension.cjs'), `const v = require('vscode');
let task; let fetched; let original; let active; let edits = 0; let creates = 0; let closes = 0; let releasedListeners = 0;
exports.activate = context => {
	original = new v.Task({type: 'fetched-custom', target: 'original'}, v.TaskScope.Workspace, 'Original custom', 'Custom provider', new v.CustomExecution(async definition => {
		if (definition.target !== 'edited-' + edits) throw Error('Edited definition did not reach original callback');
		creates++;
		const write = new v.EventEmitter(); const done = new v.EventEmitter();
		const event = emitter => listener => { const handle = emitter.event(listener); let disposed = false; return {dispose() { if (disposed) throw Error('Listener released twice'); disposed = true; releasedListeners++; handle.dispose(); }}; };
		let closed = false;
		return {onDidWrite: event(write), onDidClose: event(done),
			open() { write.fire('CUSTOM_EDITED_' + edits + '\\r\\n'); if (edits <= 2) { done.fire(0); write.dispose(); done.dispose(); } },
			close() { if (closed) throw Error('PTY released twice'); closed = true; closes++; write.dispose(); done.dispose(); }
		};
	}));
	context.subscriptions.push(v.tasks.registerTaskProvider('fetched-custom', {provideTasks() { return [original]; }}));
	context.subscriptions.push(v.commands.registerCommand('acme.fetchedCustom.edit', async () => {
		fetched ??= (await v.tasks.fetchTasks({type: 'fetched-custom'})).find(value => value.name === 'Original custom');
		task ??= fetched;
		if (!task || !(task.execution instanceof v.CustomExecution) || task.execution.callback !== undefined) throw Error('Invalid fetched custom execution');
		if (edits === 1) {
			task = new v.Task({...fetched.definition}, fetched.scope, 'Copied custom', fetched.source, fetched.execution, fetched.problemMatchers);
			if (task === fetched || task.execution !== fetched.execution) throw Error('Copied execution identity changed');
		}
		task.name = 'Edited custom ' + ++edits; task.definition.target = 'edited-' + edits;
		task.group = v.TaskGroup.Clean; task.presentationOptions = {reveal: v.TaskRevealKind.Always, panel: v.TaskPanelKind.Dedicated, clear: true};
		const events = []; let complete;
		const finished = new Promise(resolve => { complete = resolve; });
		const start = v.tasks.onDidStartTask(event => { if (event.execution.task === task) events.push('start'); });
		const end = v.tasks.onDidEndTask(event => { if (event.execution.task === task) { events.push('end'); complete(); } });
		const processStart = v.tasks.onDidStartTaskProcess(() => { throw Error('Custom task emitted process start'); });
		try {
			active = await v.tasks.executeTask(task);
			if (active.task !== task || original.name !== 'Original custom' || original.definition.target !== 'original') throw Error('Task identity or catalog metadata changed');
			if (edits <= 2) { await finished; if (events.join(',') !== 'start,end' || creates !== edits || closes !== 0 || releasedListeners !== edits * 2) throw Error('Custom release or event order changed'); }
			await v.window.showInformationMessage('CUSTOM_EXECUTION_STARTED_' + edits);
		} finally { start.dispose(); end.dispose(); processStart.dispose(); }
	}));
	context.subscriptions.push(v.commands.registerCommand('acme.fetchedCustom.stop', async () => {
		let handle;
		const finished = new Promise(resolve => { handle = v.tasks.onDidEndTask(event => { if (event.execution === active) resolve(); }); });
		try { active.terminate(); await finished; if (creates !== 3 || closes !== 1 || releasedListeners !== 6) throw Error('Termination did not release original PTY'); await v.window.showInformationMessage('CUSTOM_EXECUTION_RELEASED_3'); }
		finally { handle.dispose(); }
	}));
};`);
	const page = workbench.page;
	await workbench.quickaccess.runCommand('ash.extensions.installLocal');
	const installation = page.getByRole('dialog', { name: 'Install extension from workspace', exact: true });
	await installation.getByRole('textbox').fill('fetched-custom-extension');
	const installed = await workbench.dialogs.expectMessage(application, 'Information', () => installation.getByRole('textbox').press('Enter'));
	expect(installed.message).toContain('Installed acme/fetched-custom-smoke 1.0.0');
	const manage = async (button: string): Promise<void> => {
		await workbench.dialogs.confirm(application, 'Fetched custom smoke', button, async () => {
			await workbench.quickaccess.runCommand('ash.extensions.manageLocal');
			await page.getByRole('option').filter({ has: page.getByText('Fetched custom smoke', { exact: true }) }).click();
		});
	};
	await manage('Enable');
	await manage('Grant permissions');
	for (const edits of [1, 2, 3]) {
		await workbench.quickaccess.runCommand('acme.fetchedCustom.edit');
		await expect(page.locator('.ash-notification', { hasText: `CUSTOM_EXECUTION_STARTED_${edits}` })).toBeVisible();
		await expect(page.locator('.ash-terminal-tabs [role="tab"]')).toHaveCount(edits === 1 ? 1 : 2);
		await expect(page.locator('.ash-terminal-tabs [role="tab"][aria-selected="true"]').locator('..')).toHaveAttribute('data-state', edits <= 2 ? 'exited' : 'running');
	}
	await workbench.quickaccess.runCommand('acme.fetchedCustom.stop');
	await expect(page.locator('.ash-notification', { hasText: 'CUSTOM_EXECUTION_RELEASED_3' })).toBeVisible();
	await expect(page.locator('.ash-terminal-tabs [role="tab"]')).toHaveCount(1);
	await expect(page.locator('.ash-terminal-tabs [role="tab"]')).toContainText('Edited custom 1');
	await manage('Disable');
	await manage('Revoke permissions');
	await manage('Uninstall');
});

test('installed task observer receives ordered process events after termination releases the process', async ({ application, workbench, testWorkspace }) => {
	test.skip(process.platform !== 'darwin', 'Requires the product JS confinement launcher.');
	test.setTimeout(90_000);
	const directory = testWorkspace.directory;
	const root = join(directory, 'task-events-extension');
	await mkdir(join(root, '.ash-plugin'), { recursive: true });
	await writeFile(join(root, '.ash-plugin', 'plugin.json'), JSON.stringify({
		schemaVersion: 1, id: 'acme/task-events-smoke', version: '1.0.0', displayName: 'Task events smoke', compatibility: { ash: '>=0.1.0' },
		contributions: { editorExtensions: [{ id: 'tasks', runtime: 'javascript', entrypoint: 'extension.js', runtimeApiVersion: 1, activationEvents: [{ type: 'onTaskType', taskType: 'event-watch' }], capabilities: ['taskProvider', 'command'] }] },
		permissions: [{ type: 'directory', access: 'read' }],
	}));
	await writeFile(join(directory, 'task-events-run.cjs'), "require('node:fs').writeFileSync('task-events-pid.txt', String(process.pid)); console.log('TASK_EVENTS_READY'); setInterval(() => {}, 1000);");
	await writeFile(join(root, 'extension.js'), `import { tasks } from '@ash/extension';
export function activate(context) {
	const events = [];
	let executionId;
	context.subscriptions.push(tasks.registerTaskEvents('events', async (invocation, event) => {
		if (event.type === 'snapshot') return;
		if (!executionId) executionId = event.execution.id;
		if (event.execution.id !== executionId) throw Error('Execution identity changed');
		if (event.execution.task.group !== 'rebuild' || event.execution.task.groupIsDefault !== true) throw Error('Task group changed across execution events');
		events.push(event.type);
		if (event.type === 'end') await invocation.window.showInformationMessage('TASK_EVENTS:' + events.join(',') + ':active=' + event.execution.active);
	}), tasks.registerTaskProvider('watch', 'event-watch', {
		provideTasks() { return [{ id: 'watch', label: 'Event observer watch', group: 'rebuild', groupIsDefault: true, definition: { type: 'event-watch' }, cwd: ${JSON.stringify(directory)}, execution: { type: 'process', program: ${JSON.stringify(process.execPath)}, args: [${JSON.stringify(join(directory, 'task-events-run.cjs'))}] } }]; }
	}));
}`);
	const page = workbench.page;
	await workbench.quickaccess.runCommand('ash.extensions.installLocal');
	const installation = page.getByRole('dialog', { name: 'Install extension from workspace', exact: true });
	await installation.getByRole('textbox').fill('task-events-extension');
	const installed = await workbench.dialogs.expectMessage(application, 'Information', () => installation.getByRole('textbox').press('Enter'));
	expect(installed.message).toContain('Installed acme/task-events-smoke 1.0.0');
	const manage = async (button: string): Promise<void> => {
		await workbench.dialogs.confirm(application, 'Task events smoke', button, async () => {
			await workbench.quickaccess.runCommand('ash.extensions.manageLocal');
			await page.getByRole('option').filter({ has: page.getByText('Task events smoke', { exact: true }) }).click();
		});
	};
	await manage('Enable');
	await manage('Grant permissions');
	await workbench.quickaccess.runCommand('workbench.action.tasks.runTask');
	await workbench.quickaccess.select('Event observer watch');
	await expect(workbench.terminal.activeInstance).toContainText('TASK_EVENTS_READY');
	const pid = Number(await readFile(join(directory, 'task-events-pid.txt'), 'utf8'));
	await workbench.quickaccess.runCommand('workbench.action.tasks.terminate');
	await expect(page.locator('.ash-notification', { hasText: 'TASK_EVENTS:start,processStart,processEnd,end:active=false' })).toBeVisible();
	expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
	await manage('Disable');
	await manage('Revoke permissions');
	await manage('Uninstall');
});


test('configured task instance limits allow two processes, join at capacity and reuse a released slot', async ({ workbench, testWorkspace }) => {
	const directory = testWorkspace.directory;
	await writeFile(join(directory, 'limited-task.cjs'), "const fs = require('node:fs'); const count = Number(fs.readFileSync('task-runs.txt', 'utf8')) + 1; fs.writeFileSync('task-runs.txt', String(count)); fs.writeFileSync('limited-pid-' + count, String(process.pid)); console.log('LIMITED_TASK_READY_' + count); setInterval(() => {}, 1000);\n");
	await writeFile(join(directory, '.vscode', 'tasks.json'), JSON.stringify({ version: '2.0.0', tasks: [{ label: 'Limited task', type: 'process', command: process.execPath, args: ['${workspaceFolder}/limited-task.cjs'], runOptions: { instanceLimit: 2, instancePolicy: 'silent' } }] }));
	for (let index = 1; index <= 3; index++) {
		await workbench.quickaccess.runCommand('workbench.action.tasks.runTask');
		await workbench.quickaccess.select('Limited task');
		await expect.poll(() => readFile(join(directory, 'task-runs.txt'), 'utf8')).toBe(String(Math.min(index, 2)));
	}
	await expect(workbench.terminal.tabs).toHaveCount(2);
	await workbench.quickaccess.runCommand('workbench.action.tasks.terminate');
	const running = workbench.quickaccess.items.filter({ hasText: 'Limited task' });
	await expect(running).toHaveCount(2);
	await running.first().click();
	const firstPid = Number(await readFile(join(directory, 'limited-pid-1'), 'utf8'));
	await expect.poll(() => { try { process.kill(firstPid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; } }).toBe(false);
	await workbench.quickaccess.runCommand('workbench.action.tasks.runTask');
	await workbench.quickaccess.select('Limited task');
	await expect.poll(() => readFile(join(directory, 'task-runs.txt'), 'utf8')).toBe('3');
	await expect(workbench.terminal.tabs).toHaveCount(2);
	await workbench.quickaccess.runCommand('workbench.action.tasks.terminate');
	await expect(running).toHaveCount(2);
	await running.first().click();
	await workbench.quickaccess.runCommand('workbench.action.tasks.terminate');
	for (const index of [2, 3]) {
		const pid = Number(await readFile(join(directory, `limited-pid-${index}`), 'utf8'));
		await expect.poll(() => { try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; } }).toBe(false);
	}
});

test('configured task capacity policies replace the selected process, cancel the picker and warn without spawning', async ({ workbench, testWorkspace }) => {
	const page = workbench.page;
	const directory = testWorkspace.directory;
	await writeFile(join(directory, 'policy-task.cjs'), "const fs = require('node:fs'); const prefix = process.argv[2]; const file = prefix + '-runs'; const count = Number(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 0) + 1; fs.writeFileSync(prefix + '-pid-' + count, String(process.pid)); fs.writeFileSync(file, String(count)); console.log('POLICY_READY_' + count); setInterval(() => {}, 1000);\n");
	const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; } };
	for (const policy of ['terminateOldest', 'terminateNewest', 'prompt', 'warn'] as const) {
		await writeFile(join(directory, `${policy}-runs`), '0');
		const label = `Capacity ${policy}`;
		await writeFile(join(directory, '.vscode', 'tasks.json'), JSON.stringify({ version: '2.0.0', tasks: [{ label, type: 'process', command: process.execPath, args: ['${workspaceFolder}/policy-task.cjs', policy], runOptions: { instanceLimit: 2, ...(policy === 'prompt' ? {} : { instancePolicy: policy }) } }] }));
		const run = async (): Promise<void> => {
			await workbench.quickaccess.runCommand('workbench.action.tasks.runTask');
			await workbench.quickaccess.select(label);
		};
		for (let index = 1; index <= 2; index++) {
			await run();
			await expect.poll(() => readFile(join(directory, `${policy}-runs`), 'utf8')).toBe(String(index));
			await expect(workbench.terminal.activeInstance).toContainText(`POLICY_READY_${index}`);
		}
		const pids = await Promise.all([1, 2].map(async index => Number(await readFile(join(directory, `${policy}-pid-${index}`), 'utf8'))));
		await run();
		if (policy === 'prompt') {
			await expect(workbench.quickaccess.input).toHaveAttribute('aria-label', `Task '${label}' is at its instance limit. Select an instance to terminate and restart.`);
			await expect(workbench.quickaccess.input).toBeFocused();
			await workbench.quickaccess.close();
			expect(await readFile(join(directory, `${policy}-runs`), 'utf8')).toBe('2');
			expect(pids.map(alive)).toEqual([true, true]);
			await run();
			await expect(workbench.quickaccess.input).toHaveAttribute('aria-label', `Task '${label}' is at its instance limit. Select an instance to terminate and restart.`);
			await workbench.quickaccess.input.fill('instance 2');
			await expect(workbench.quickaccess.items).toHaveCount(1);
			await workbench.quickaccess.input.press('Enter');
		} else if (policy === 'warn') {
			await expect(page.locator('.ash-notification', { hasText: `Task '${label}' has reached its limit of 2 running instance(s).` })).toBeVisible();
			expect(await readFile(join(directory, `${policy}-runs`), 'utf8')).toBe('2');
			expect(pids.map(alive)).toEqual([true, true]);
		}
		if (policy !== 'warn') {
			await expect.poll(() => readFile(join(directory, `${policy}-runs`), 'utf8')).toBe('3');
			const stopped = policy === 'terminateOldest' ? 0 : 1;
			await expect.poll(() => alive(pids[stopped])).toBe(false);
			expect(alive(pids[1 - stopped])).toBe(true);
			pids.push(Number(await readFile(join(directory, `${policy}-pid-3`), 'utf8')));
		}
		await expect(workbench.terminal.tabs).toHaveCount(2);
		await workbench.quickaccess.runCommand('workbench.action.tasks.terminate');
		const running = workbench.quickaccess.items.filter({ hasText: label });
		await expect(running).toHaveCount(2);
		await running.first().click();
		await workbench.quickaccess.runCommand('workbench.action.tasks.terminate');
		for (const pid of pids) await expect.poll(() => alive(pid)).toBe(false);
		await expect(workbench.terminal.tabs).toHaveCount(0);
	}
});


test('superseding an extension task query delivers cancellation and retains the active provider', async ({ workbench, application, testWorkspace }) => {
	const directory = testWorkspace.directory;
	const root = join(directory, 'cancellation-extension');
	await mkdir(join(root, '.ash-plugin'), { recursive: true });
	await writeFile(join(root, '.ash-plugin', 'plugin.json'), JSON.stringify({ schemaVersion: 1, id: 'acme/task-cancellation', version: '1.0.0', displayName: 'Task cancellation smoke', compatibility: { ash: '>=0.1.0' }, contributions: { editorExtensions: [{ id: 'tasks', runtime: 'javascript', entrypoint: 'extension.js', runtimeApiVersion: 1, activationEvents: [{ type: 'onCommand', id: 'acme.taskCancellation.arm' }], capabilities: ['command', 'taskProvider'] }] }, permissions: [{ type: 'directory', access: 'read' }] }));
	await writeFile(join(root, 'extension.js'), `
import { commands, tasks } from '@ash/extension';
let armed = false;
let cancellations = 0;
export function activate(context) {
	context.subscriptions.push(commands.registerCommand('acme.taskCancellation.arm', 'Arm task cancellation', async call => {
		armed = true;
		await call.window.showInformationMessage('Task cancellation armed');
	}));
	context.subscriptions.push(commands.registerCommand('acme.taskCancellation.probe', 'Probe task cancellation', async call => {
		await call.window.showInformationMessage('Task cancellation count: ' + cancellations);
	}));
	context.subscriptions.push(tasks.registerTaskProvider('provider', 'cancellation-smoke', {
		async provideTasks(call) {
			if (armed) {
				armed = false;
				const finished = new Promise(resolve => call.cancellationToken.onCancellationRequested(() => {
					if (!call.cancellationToken.isCancellationRequested) throw Error('Missing cancellation flag');
					cancellations++;
					resolve();
				}));
				await call.window.showInformationMessage('Task query waiting').catch(() => {});
				await finished;
			}
			return [{ id: 'provided', label: 'Retained task provider', group: 'other', source: 'Cancellation smoke', definition: { type: 'cancellation-smoke' }, execution: { type: 'process', program: ${JSON.stringify(process.execPath)}, args: [${JSON.stringify(join(directory, 'smoke-task.cjs'))}] } }];
		}
	}));
}`);
	const page = workbench.page;
	await workbench.quickaccess.runCommand('ash.extensions.installLocal');
	const installation = page.getByRole('dialog', { name: 'Install extension from workspace', exact: true });
	await installation.getByRole('textbox').fill('cancellation-extension');
	const installed = await workbench.dialogs.expectMessage(application, 'Information', () => installation.getByRole('textbox').press('Enter'));
	expect(installed.message).toContain('Installed acme/task-cancellation 1.0.0');
	const manage = async (button: string): Promise<void> => {
		await workbench.dialogs.confirm(application, 'Task cancellation smoke', button, async () => {
			await workbench.quickaccess.runCommand('ash.extensions.manageLocal');
			await page.getByRole('option').filter({ has: page.getByText('Task cancellation smoke', { exact: true }) }).click();
		});
	};
	await manage('Enable');
	await manage('Grant permissions');
	await workbench.quickaccess.runCommand('acme.taskCancellation.arm');
	await expect(page.locator('.ash-notification', { hasText: 'Task cancellation armed' })).toBeVisible();
	await workbench.quickaccess.runCommand('workbench.action.tasks.runTask');
	await expect(page.locator('.ash-notification', { hasText: 'Task query waiting' })).toBeVisible();
	await writeFile(join(directory, '.vscode', 'tasks.json'), JSON.stringify({ version: '2.0.0', tasks: [] }));
	await expect(workbench.quickaccess.items.filter({ hasText: 'Retained task provider' })).toBeVisible();
	await workbench.quickaccess.close();
	await workbench.quickaccess.runCommand('acme.taskCancellation.probe');
	await expect(page.locator('.ash-notification', { hasText: 'Task cancellation count: 1' })).toBeVisible();
	await workbench.quickaccess.runCommand('workbench.action.tasks.runTask');
	await workbench.quickaccess.select('Retained task provider');
	await expect.poll(() => readFile(join(directory, 'task-runs.txt'), 'utf8')).toBe('1');
	await manage('Disable');
	await manage('Revoke permissions');
	await manage('Uninstall');
});

test('configured default globs select the active file before boolean defaults and retain unmatched fallback', async ({ workbench, testWorkspace }) => {
	const directory = testWorkspace.directory;
	const log = join(directory, 'task-default-globs.jsonl');
	await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'task-default-globs', version: '1.0.0' }));
	await unlink(join(directory, 'Cargo.toml'));
	await writeFile(log, '');
	await writeFile(join(directory, 'task-default-globs.cjs'), "require('node:fs').appendFileSync('task-default-globs.jsonl', JSON.stringify(process.argv[2]) + '\\n');\n");
	await writeFile(join(directory, 'default.TS'), 'export const value = 1;\n');
	await writeFile(join(directory, 'default.md'), 'Task defaults\n');
	const configure = async (secondary: boolean | string, fallback = true): Promise<void> => {
		const definitions = [
			{ label: 'Build TypeScript', group: 'build', isDefault: '**/*.ts' },
			{ label: 'Build secondary', group: 'build', isDefault: secondary },
			{ label: 'Build fallback', group: 'build', isDefault: fallback },
			{ label: 'Test TypeScript', group: 'test', isDefault: '**/*.{ts,tsx}' },
			{ label: 'Test fallback', group: 'test', isDefault: true },
		];
		await writeFile(join(directory, '.vscode', 'tasks.json'), JSON.stringify({ version: '2.0.0', tasks: definitions.map(task => ({ label: task.label, type: 'process', command: process.execPath, args: [join(directory, 'task-default-globs.cjs'), task.label], group: { kind: task.group, isDefault: task.isDefault } })) }));
	};
	const executed = async (): Promise<string[]> => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
	const expected: string[] = [];
	const assertRun = async (label: string): Promise<void> => { expected.push(label); await expect.poll(executed).toEqual(expected); };
	await configure(false);
	await workbench.openExplorer();
	const explorer = workbench.page.locator('.ash-explorer');
	await explorer.getByRole('treeitem', { name: 'default.TS', exact: true }).dblclick();
	await expect(workbench.editors.groupAt(0).tabs.getByText('default.TS', { exact: true })).toBeVisible();
	await workbench.editors.groupAt(0).editor.waitForEditorContents(content => content.includes('export const value = 1'));
	await workbench.quickaccess.runCommand('workbench.action.tasks.build');
	await assertRun('Build TypeScript');
	await workbench.quickaccess.runCommand('workbench.action.tasks.test');
	await assertRun('Test TypeScript');
	await configure('**/*.TS');
	await workbench.quickaccess.runCommand('workbench.action.tasks.build');
	const picker = workbench.page.getByRole('dialog', { name: 'Select the build task to run', exact: true });
	await expect(picker.getByRole('option')).toHaveCount(2);
	await expect(picker.getByRole('option').filter({ hasText: 'Build fallback' })).toHaveCount(0);
	await picker.getByRole('combobox').press('Escape');
	expect(await executed()).toEqual(expected);
	await workbench.quickaccess.runCommand('workbench.action.tasks.build');
	await picker.getByRole('option').filter({ hasText: 'Build secondary' }).click();
	await assertRun('Build secondary');
	await workbench.openExplorer();
	await explorer.getByRole('treeitem', { name: 'default.md', exact: true }).dblclick();
	await workbench.editors.groupAt(0).editor.waitForEditorContents(content => content.includes('Task defaults'));
	await workbench.quickaccess.runCommand('workbench.action.tasks.build');
	await assertRun('Build fallback');
	await workbench.quickaccess.runCommand('workbench.action.closeAllEditors');
	await workbench.quickaccess.runCommand('workbench.action.tasks.build');
	await assertRun('Build fallback');
	await configure('**/*.TS', false);
	await workbench.quickaccess.runCommand('workbench.action.tasks.build');
	await expect(picker.getByRole('option')).toHaveCount(3);
	await picker.getByRole('combobox').press('Escape');
	expect(await executed()).toEqual(expected);
});

test('standard build and test commands run unique defaults and keep ambiguous selection within the requested group', async ({ workbench, testWorkspace, restartWorkbench }) => {
	const directory = testWorkspace.directory;
	const log = join(directory, 'task-groups.jsonl');
	await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'task-group-commands', version: '1.0.0' }));
	await unlink(join(directory, 'Cargo.toml'));
	await writeFile(log, '');
	await writeFile(join(directory, 'group-task.cjs'), "require('node:fs').appendFileSync('task-groups.jsonl', JSON.stringify(process.argv[2]) + '\\n');\n");
	const names = ['Build primary', 'Build secondary', 'Test primary', 'Test secondary', 'Clean default'];
	const configure = async (defaults: readonly string[], included: readonly string[] = names): Promise<void> => {
		await writeFile(join(directory, '.vscode', 'tasks.json'), JSON.stringify({ version: '2.0.0', tasks: included.map(label => ({ label, type: 'process', command: process.execPath, args: [join(directory, 'group-task.cjs'), label], group: { kind: label.startsWith('Build') ? 'build' : label.startsWith('Test') ? 'test' : 'clean', isDefault: defaults.includes(label) } })) }));
	};
	const executed = async (): Promise<string[]> => (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
	await configure(['Build primary', 'Test primary', 'Clean default']);
	await workbench.quickaccess.runCommand('workbench.action.tasks.build');
	await expect.poll(executed).toEqual(['Build primary']);
	await expect(workbench.page.getByRole('dialog', { name: 'Select the build task to run', exact: true })).toHaveCount(0);
	await workbench.quickaccess.runCommand('workbench.action.tasks.test');
	await expect.poll(executed).toEqual(['Build primary', 'Test primary']);

	await configure(['Build primary', 'Build secondary', 'Clean default']);
	await workbench.quickaccess.runCommand('workbench.action.tasks.build');
	const picker = workbench.page.getByRole('dialog', { name: 'Select the build task to run', exact: true });
	await expect(picker.getByRole('option')).toHaveCount(2);
	await expect(picker.getByRole('option').filter({ hasText: 'Build primary' })).toBeVisible();
	await expect(picker.getByRole('option').filter({ hasText: 'Build secondary' })).toBeVisible();
	await picker.getByRole('combobox').press('Escape');
	expect(await executed()).toEqual(['Build primary', 'Test primary']);
	await workbench.quickaccess.runCommand('workbench.action.tasks.build');
	await picker.getByRole('option').filter({ hasText: 'Build secondary' }).click();
	await expect.poll(executed).toEqual(['Build primary', 'Test primary', 'Build secondary']);

	await configure(['Clean default']);
	await workbench.quickaccess.runCommand('workbench.action.tasks.test');
	const testPicker = workbench.page.getByRole('dialog', { name: 'Select the test task to run', exact: true });
	await expect(testPicker.getByRole('option')).toHaveCount(2);
	await testPicker.getByRole('option').filter({ hasText: 'Test secondary' }).click();
	await expect.poll(executed).toEqual(['Build primary', 'Test primary', 'Build secondary', 'Test secondary']);

	await configure(['Clean default'], ['Clean default']);
	await workbench.quickaccess.runCommand('workbench.action.tasks.build');
	await expect(workbench.page.locator('.ash-notification', { hasText: 'No build task is available.' })).toBeVisible();
	expect(await executed()).toEqual(['Build primary', 'Test primary', 'Build secondary', 'Test secondary']);

	await workbench.quickaccess.runCommand('workbench.action.configureLocale');
	const language = workbench.page.getByRole('dialog', { name: 'Select Display Language' }).getByRole('combobox');
	await language.fill('简体中文');
	await language.press('Enter');
	({ workbench } = await restartWorkbench());
	await configure([]);
	await workbench.quickaccess.open('>workbench.action.tasks.build');
	await expect(workbench.quickaccess.items.locator('.ash-quick-pick-row-label')).toHaveText('运行生成任务');
	await workbench.quickaccess.close();
	await workbench.quickaccess.runCommand('workbench.action.tasks.build');
	const chinesePicker = workbench.page.getByRole('dialog', { name: '选择要运行的生成任务', exact: true });
	await expect(chinesePicker.getByRole('option')).toHaveCount(2);
	await chinesePicker.getByRole('combobox').press('Escape');
	await configure(['Clean default'], ['Clean default']);
	await workbench.quickaccess.runCommand('workbench.action.tasks.test');
	await expect(workbench.page.locator('.ash-notification', { hasText: '没有可运行的测试任务。' })).toBeVisible();
	expect(await executed()).toEqual(['Build primary', 'Test primary', 'Build secondary', 'Test secondary']);
});

const developerEnvironmentTest = test.extend({
	testWorkspace: async ({ testWorkspace }, use) => {
		// This fixture runs before either backend starts and restores this worker's environment.
		const values = { OPENAI_API_KEY: 'ash-synthetic-developer-key', ASH_DEVELOPER_REMOVED: 'remove me', CODEX_EXEC_SERVER_NOISE_AUTH_TOKEN: 'ash-synthetic-host-control' };
		const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
		try {
			Object.assign(process.env, values);
			await use(testWorkspace);
		} finally {
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) { delete process.env[key]; }
				else { process.env[key] = value; }
			}
		}
	},
});

developerEnvironmentTest('developer environment reaches process and shell tasks with variable resolution and child overrides', async ({ workbench, testWorkspace }) => {
	const directory = testWorkspace.directory;
	await writeFile(join(directory, 'developer-env.cjs'), `require('node:fs').writeFileSync(process.argv[2] + '.json', JSON.stringify({ resolved: process.argv[3], credential: process.env.OPENAI_API_KEY, removed: process.env.ASH_DEVELOPER_REMOVED === undefined, privateExcluded: process.env.CODEX_EXEC_SERVER_NOISE_AUTH_TOKEN === undefined }));`);
	await writeFile(join(directory, '.vscode', 'tasks.json'), JSON.stringify({
		version: '2.0.0', tasks: ['process', 'shell'].map(type => ({
			label: 'Developer ' + type, type, command: process.execPath,
			args: ['developer-env.cjs', type, '${env:OPENAI_API_KEY}'],
			options: { env: { OPENAI_API_KEY: 'child credential', ASH_DEVELOPER_REMOVED: null, CODEX_EXEC_SERVER_NOISE_AUTH_TOKEN: 'blocked child control' } },
		}))
	}));
	for (const type of ['process', 'shell']) {
		await workbench.quickaccess.runCommand('workbench.action.tasks.runTask');
		await workbench.quickaccess.select('Developer ' + type);
		await expect.poll(async () => JSON.parse(await readFile(join(directory, type + '.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return 'null'; throw error; }))).toEqual({ resolved: 'ash-synthetic-developer-key', credential: 'child credential', removed: true, privateExcluded: true });
	}
});
