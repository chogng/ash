import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { _electron, expect, type ElectronApplication } from '@playwright/test';

const repository = resolve(import.meta.dirname, '..');

// This checks the development workspace's VS Code settings with a real extension host.
// The optional executable and isolated extension directory are provisioned by the caller.
test(
	'VS Code save formatting matches the workspace CI formatters',
	{
		skip: !process.env.ASH_VSCODE_EXECUTABLE,
		timeout: 120_000,
	},
	async t => {
		const directory = await mkdtemp(join(tmpdir(), 'ash-format-editor-'));
		const workspace = join(directory, 'workspace');
		const harness = join(directory, 'harness');
		const profile = join(directory, 'profile');
		const output = join(repository, '.build/formatter-editor-validation');
		const resultPath = join(directory, 'result.json');
		let application: ElectronApplication | undefined;
		t.after(async () => {
			try {
				await application?.close();
			} finally {
				await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
			}
		});
		for (const path of [join(workspace, '.vscode'), join(workspace, 'build'), join(workspace, 'node_modules'), harness, join(profile, 'User'), output]) await mkdir(path, { recursive: true });
		for (const name of ['tsfmt.json', 'build/format.ts', '.prettierrc.toml', '.prettierignore', '.gitignore', '.editorconfig', '.vscode/settings.json']) await copyFile(join(repository, name), join(workspace, name));
		await symlink(join(repository, 'node_modules/bun'), join(workspace, 'node_modules/bun'), process.platform === 'win32' ? 'junction' : 'dir');
		await symlink(join(repository, 'node_modules/typescript'), join(workspace, 'node_modules/typescript'), process.platform === 'win32' ? 'junction' : 'dir');
		assert.equal(spawnSync('git', ['init', '--quiet', workspace], { encoding: 'utf8' }).status, 0);
		await writeFile(
			join(profile, 'User/settings.json'),
			JSON.stringify({
				'security.workspace.trust.enabled': false,
				'update.mode': 'none',
				'telemetry.telemetryLevel': 'off',
				'workbench.startupEditor': 'none',
				'extensions.autoUpdate': false,
				'files.autoSave': 'off',
			}),
		);
		const samples = [
			['typescript', 'src/source.ts', 'export const value={name:"example"}\n'],
			['typescriptreact', 'src/component.tsx', 'export const View=()=> <div title="example"/>\n'],
			['javascript', 'src/source.js', 'const value={name:"example"}\n'],
			['javascriptreact', 'src/component.jsx', 'export const View=()=> <div title="example"/>\n'],
			['json', 'config [with spaces].json', '{"value":1,"nested":{"enabled":true}}\n'],
			['json', 'config $(touch formatter-shell-marker).json', '{"value":1,"nested":{"enabled":true}}\n'],
			['json', 'localized.json', JSON.stringify({ value: '中文'.repeat(30_000) }) + '\n'],
			['json', 'blank.json', ' \n'],
			['jsonc', '.vscode/sample.jsonc', '{\n// retained comment\n"value":1,\n"nested":{"enabled":true},\n}\n'],
			['yaml', 'workflow.yaml', 'name:   example\non: [push,pull_request]\n'],
			['markdown', 'notes.md', '#   Heading\n\n```ts\nconst value=1\n```\n'],
			['css', 'style.css', '.example{color:red;padding:0  1px}\n'],
			['html', 'index.html', '<main><p>example</p><p>text</p></main>\n'],
			['json', 'fixtures/unchanged.json', 'invalid ignored fixture\n'],
			['json', 'output/generated.json', 'invalid generated input\n'],
		];
		const cases = [];
		const bun = join(repository, 'node_modules/bun', process.platform === 'win32' ? 'bun.exe' : 'bun');
		for (const [language, name, input] of samples) {
			const file = join(workspace, name);
			await mkdir(dirname(file), { recursive: true });
			await writeFile(file, '');
			const source = ['typescript', 'typescriptreact', 'javascript', 'javascriptreact'].includes(language);
			const arguments_ = source ? [join(workspace, 'build/format.ts'), '--stdin-filepath', file] : ['fmt', '--ignore-path', '.gitignore', '--ignore-path', '.prettierignore', '--stdin-filepath', file];
			const formatted = spawnSync(bun, arguments_, { cwd: workspace, input, encoding: 'utf8' });
			assert.equal(formatted.status, 0, formatted.stdout + formatted.stderr);
			if (!name.startsWith('fixtures/') && !name.startsWith('output/')) assert.notEqual(formatted.stdout, input, name);
			cases.push({ language, name, file, input, expected: formatted.stdout });
		}
		await writeFile(
			join(harness, 'package.json'),
			JSON.stringify({
				name: 'formatter-save-validation',
				publisher: 'ash-test',
				version: '1.0.0',
				engines: { vscode: '^1.80.0' },
				activationEvents: ['onStartupFinished'],
				main: './extension.cjs',
			}),
		);
		await writeFile(
			join(harness, 'extension.cjs'),
			`
const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs');
exports.activate = async () => {
  const report = { vscode: vscode.version, cases: [] };
  try {
    const formatter = vscode.extensions.getExtension('wdomitrz.simple-lsp-client');
    assert.ok(formatter, 'The real Simple LSP Client extension must be installed.');
    await formatter.activate();
    report.extensionVersion = formatter.packageJSON.version;
    for (const item of ${JSON.stringify(cases)}) {
      const document = await vscode.workspace.openTextDocument(item.file);
      assert.equal(document.languageId, item.language, item.name);
      const editor = await vscode.window.showTextDocument(document);
      const configuration = vscode.workspace.getConfiguration('editor', document);
      assert.equal(configuration.get('defaultFormatter'), formatter.id, item.name);
      assert.equal(configuration.get('formatOnSave'), true, item.name);
      const range = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
      assert.equal(await editor.edit(edit => edit.replace(range, item.input)), true);
      assert.equal(document.isDirty, true, 'The input must be an unsaved buffer.');
      assert.equal(fs.readFileSync(item.file, 'utf8'), '', 'Editing must not write the buffer.');
      await vscode.commands.executeCommand('workbench.action.files.save');
      assert.equal(document.isDirty, false, item.name);
      assert.equal(Buffer.compare(fs.readFileSync(item.file), Buffer.from(item.expected)), 0, item.name);
      assert.equal(document.getText() === item.expected, true, item.name);
      assert.equal(fs.existsSync(${JSON.stringify(join(workspace, 'formatter-shell-marker'))}), false, 'File names must not execute shell commands.');
      report.cases.push({ language: item.language, file: item.name, passed: true });
    }
    report.passed = true;
  } catch (error) { report.passed = false; report.error = error.stack || String(error); }
  fs.writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(report, null, 2));
};
`,
		);
		const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
		delete environment.ELECTRON_RUN_AS_NODE;
		application = await _electron.launch({
			executablePath: process.env.ASH_VSCODE_EXECUTABLE,
			args: [
				`--user-data-dir=${profile}`,
				`--extensions-dir=${process.env.ASH_FORMATTER_EXTENSIONS ?? join(output, 'extensions')}`,
				`--extensionDevelopmentPath=${harness}`,
				'--disable-workspace-trust',
				'--skip-welcome',
				'--skip-release-notes',
				'--new-window',
				workspace,
			],
			env: environment,
			timeout: 30_000,
		});
		await application.context().tracing.start({ screenshots: true, snapshots: true });
		await expect
			.poll(
				async () => {
					try {
						return JSON.parse(await readFile(resultPath, 'utf8'));
					} catch (error) {
						if (error.code === 'ENOENT') return undefined;
						throw error;
					}
				},
				{ timeout: 60_000 },
			)
			.toBeTruthy();
		const report = JSON.parse(await readFile(resultPath, 'utf8'));
		if (report.passed) {
			const checked = spawnSync(
				bun,
				['fmt', '--ignore-path', '.gitignore', '--ignore-path', '.prettierignore', '--check', '**/*.{json,jsonc,yml,yaml,md,css,html}'],
				{
					cwd: workspace,
					encoding: 'utf8',
				},
			);
			report.ciCheck = { status: checked.status, output: checked.stdout + checked.stderr };
			const sources = spawnSync(bun, [join(workspace, 'build/format.ts'), '--check', 'src'], { cwd: workspace, encoding: 'utf8' });
			report.ciCheck.output += sources.stdout + sources.stderr;
			report.passed = checked.status === 0 && sources.status === 0;
		}
		await writeFile(join(output, 'editor-result.json'), JSON.stringify(report, null, 2) + '\n');
		await (await application.firstWindow()).screenshot({ path: join(output, 'editor-save.png') });
		await application.context().tracing.stop({ path: join(output, 'editor-save-trace.zip') });
		assert.equal(report.passed, true, report.error ?? report.ciCheck?.output);
		assert.equal(report.cases.length, samples.length);
	},
);
