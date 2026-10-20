import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

const repository = resolve(import.meta.dirname, '../..');

test('a TypeScript author installs the packed Ash SDK and builds outside the checkout without Rust', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'ash-typescript-author-'));
	try {
		const project = join(directory, 'extension');
		const artifacts = join(directory, 'packages');
		await mkdir(project); await mkdir(artifacts);
		// Use Node's bundled npm CLI directly, including on Windows where npm.cmd
		// would otherwise require a shell. Only local package archives are admitted.
		const npm = await realpath(resolve(dirname(process.execPath), process.platform === 'win32' ? 'node_modules/npm/bin/npm-cli.js' : 'npm'));
		const runNpm = (args: string[], cwd: string) => execFileSync(process.execPath, [npm, ...args, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', join(directory, 'cache')], { cwd, encoding: 'utf8', timeout: 30_000 });
		const packed = JSON.parse(runNpm(['pack', join(repository, 'sdk/typescript'), '--json', '--pack-destination', artifacts], directory)) as { filename: string; files: { path: string; }[]; }[];
		assert.equal(packed.length, 1);
		const archive = join(artifacts, packed[0].filename);
		await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'independent-ash-extension', version: '1.0.0', private: true, type: 'module' }));
		runNpm(['install', archive, '--package-lock=false'], project);
		const installed = join(project, 'node_modules/@ash/sdk');
		assert.equal(await realpath(installed), join(await realpath(project), 'node_modules/@ash/sdk'), 'the author receives a package copy, not a link into the Ash checkout');
		const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
		assert.equal(manifest.name, '@ash/sdk');
		assert.deepEqual(Object.keys(manifest.dependencies ?? {}), [], 'the author does not install Ash internals');
		assert(!packed[0].files.some(file => /(?:^|\/)(?:Cargo\.(?:toml|lock)|crates|resources\/extension-host)(?:\/|$)/u.test(file.path)), 'Rust and host implementations stay in the Ash product');
		await writeFile(join(project, 'extension.ts'), `import * as ash from '@ash/sdk';
export function activate(context: ash.ExtensionContext): void {
  context.subscriptions.push(ash.commands.register('example.read', async (path: string) => {
    const text: string = await ash.files.readTextFile(path);
    return text.toUpperCase();
  }));
  context.subscriptions.push(
    ash.languages.registerHoverProvider('typescript', { provideHover(document, position, token) {
      return token.isCancellationRequested ? undefined : new ash.Hover(document.getText(), new ash.Range(position, position));
    } }),
    ash.languages.registerCompletionItemProvider('typescript', { provideCompletionItems() {
      return new ash.CompletionList([new ash.CompletionItem('Ash completion', ash.CompletionItemKind.Text)]);
    } }),
    ash.tasks.registerTaskProvider('example', { provideTasks() {
      return [new ash.Task({type: 'example'}, ash.TaskScope.Workspace, 'Build', 'example', new ash.ProcessExecution('node', ['build.mjs']))];
    } }),
    ash.debug.registerDebugConfigurationProvider('example', { resolveDebugConfiguration(_folder, configuration) { return configuration; } }),
    ash.debug.registerDebugAdapterDescriptorFactory('example', { createDebugAdapterDescriptor() { return new ash.DebugAdapterExecutable('node', ['adapter.mjs']); } }),
    ash.speech.registerSpeechProvider('example', {
      provideSpeechToTextSession() { return {onDidChange: new ash.EventEmitter<{status: ash.SpeechToTextStatus; text?: string}>().event}; },
      provideTextToSpeechSession() { return {onDidChange: new ash.EventEmitter<{status: ash.TextToSpeechStatus}>().event, async synthesize(_text: string) {}}; },
      provideKeywordRecognitionSession() { return {onDidChange: new ash.EventEmitter<{status: ash.KeywordRecognitionStatus}>().event}; }
    })
  );
  // @ts-expect-error Ash command registration uses register.
  ash.commands.registerCommand('legacy', () => undefined);
  // @ts-expect-error Ash command execution uses execute.
  ash.commands.executeCommand('legacy');
  // @ts-expect-error The SDK has no generic backend request escape.
  void ash.backend;
  // @ts-expect-error Editors are exposed through domain operations.
  void ash.editors;
  // @ts-expect-error Completion commands are not implemented by the host.
  new ash.CompletionItem('unsupported').command = {command: 'example.read', title: 'Read'};
  // @ts-expect-error This completion kind is not supported by the host.
  void ash.CompletionItemKind.Color;
}
`);
		await writeFile(join(project, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', types: [], lib: ['ES2022'], outDir: 'dist' }, include: ['extension.ts'] }));
		const require = createRequire(import.meta.url);
		const compiler = resolve(dirname(require.resolve('@ash/typescript-compiler/package.json')), 'bin/tsc');
		const built = spawnSync(process.execPath, [compiler, '--project', join(project, 'tsconfig.json')], { cwd: project, encoding: 'utf8', timeout: 30_000 });
		assert.ifError(built.error);
		assert.equal(built.status, 0, built.stdout + built.stderr);
		const compiled = await readFile(join(project, 'dist/extension.js'), 'utf8');
		assert.match(compiled, /from ['"]@ash\/sdk['"]/u);
		assert.doesNotMatch(compiled, /src\/ash|Cargo|vscode/u);
		assert(!compiled.includes(repository));
		// Compile the maintained author example as shipped, using the installed SDK
		// above it rather than the checkout's TypeScript paths or node_modules.
		const example = join(project, 'inspect');
		await mkdir(example);
		for (const name of ['extension.ts', 'package.json', 'tsconfig.json']) {
			await copyFile(join(repository, 'examples/extensions/inspect', name), join(example, name));
		}
		const exampleBuild = spawnSync(process.execPath, [compiler, '--project', join(example, 'tsconfig.json')], { cwd: example, encoding: 'utf8', timeout: 30_000 });
		assert.ifError(exampleBuild.error);
		assert.equal(exampleBuild.status, 0, exampleBuild.stdout + exampleBuild.stderr);
		const exampleScript = await readFile(join(example, 'dist/extension.js'), 'utf8');
		assert.match(exampleScript, /from ['"]@ash\/sdk['"]/u);
		assert.doesNotMatch(exampleScript, /src\/ash|Cargo|vscode/u);
		// Successful installation does not grant a standalone Node program any
		// product authority. The host must provide the current extension's bridge.
		execFileSync(process.execPath, ['--input-type=module', '-e', `
import assert from 'node:assert/strict';
import * as ash from '@ash/sdk';
assert.throws(() => ash.commands.register('outside.read', () => undefined), /Ash.*host|unavailable|not.*host/i);
await assert.rejects(async () => ash.files.readTextFile('notes.txt'), /Ash.*host|unavailable|not.*host/i);
`], { cwd: project, stdio: 'pipe', timeout: 10_000 });
	} finally { await rm(directory, { recursive: true, force: true }); }
});
