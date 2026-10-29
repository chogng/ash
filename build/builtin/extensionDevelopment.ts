import { spawn } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileEditorClient } from './editorClients.ts';
import { buildEditorPackage } from './editorPackages.ts';
import { validateEditorClientApi } from './editorClientApi.ts';

async function run(command: string, args: string[], cwd: string): Promise<void> {
	const child = spawn(command, args, { cwd, stdio: 'inherit', shell: false });
	// When launched from an agent or IDE, cancellation may reach only this wrapper.
	// Forward it and await the child so the native supervisor can reap the extension.
	const interrupt = () => {
		child.kill('SIGINT');
	};
	const terminate = () => {
		child.kill('SIGTERM');
	};
	process.once('SIGINT', interrupt);
	process.once('SIGTERM', terminate);
	try {
		await new Promise<void>((accept, reject) => {
			child.once('error', reject);
			child.once('exit', code => (code === 0 ? accept() : reject(new Error(`${command} exited ${code}`))));
		});
	} finally {
		process.removeListener('SIGINT', interrupt);
		process.removeListener('SIGTERM', terminate);
	}
}

/** Portable CLI: no private Ash source or installation authority is available here. */
export async function develop(sdk: string, args: string[]): Promise<void> {
	const [command, directory, ...rest] = args;
	if (!directory || !['build', 'check', 'client', 'debug', 'package'].includes(command))
		throw new Error('Usage: dev.mjs <build|check|client|debug|package> <project> [arguments]');
	const project = resolve(directory);
	const api = validateEditorClientApi(JSON.parse(await readFile(resolve(sdk, 'editor-api.json'), 'utf8')));
	const manifest = JSON.parse(await readFile(resolve(project, 'package.json'), 'utf8'));
	if (
		manifest.ashRuntime?.kind !== 'rust' ||
		!/^[a-z0-9-]+$/u.test(manifest.ashRuntime.entrypoint) ||
		!/^[a-z0-9-]+$/u.test(manifest.name) ||
		!/^[a-z0-9-]+$/u.test(manifest.publisher)
	)
		throw new Error('Invalid development extension manifest');
	const executable = `target/debug/${manifest.ashRuntime.entrypoint}${process.platform === 'win32' ? '.exe' : ''}`;
	if (command === 'debug') {
		if (rest.length !== 1 || rest[0] !== '--allow-local-code')
			throw new Error(
				'debug requires --allow-local-code: the extension runs as trusted local code without OS isolation',
			);
		await run(
			resolve(sdk, 'bin', process.platform === 'win32' ? 'editor_dev.exe' : 'editor_dev'),
			['--allow-local-code', project, executable, `${manifest.publisher}.${manifest.name}`],
			project,
		);
		return;
	}
	if (command === 'package') {
		if (rest.length !== 2) throw new Error('package requires <new-output-directory> <target-platform>');
		await buildEditorPackage(
			project,
			[{ targetPlatform: rest[1], path: resolve(project, executable) }],
			resolve(rest[0]),
			{ api, licenseFile: resolve(project, 'LICENSE') },
		);
		return;
	}
	if (rest.length) throw new Error('Unexpected development arguments');
	if (command === 'build' || command === 'check') {
		await run('cargo', [command === 'build' ? 'build' : 'test', '--locked'], project);
		const compiler = JSON.parse(await readFile(resolve(sdk, 'node_modules/typescript/package.json'), 'utf8'));
		const cli = compiler.bin.tsc ?? compiler.bin.tsc6;
		if (typeof cli !== 'string' || !cli.startsWith('./bin/'))
			throw new Error('Unsupported SDK TypeScript compiler');
		await run(
			process.execPath,
			[resolve(sdk, 'node_modules/typescript', cli), '--project', resolve(project, 'tsconfig.json'), '--noEmit'],
			project,
		);
	}
	if (command !== 'check') {
		const compiled = await compileEditorClient(project, api);
		for (const [path, value] of Object.entries({
			...compiled.resources,
			'dist/client.json': JSON.stringify(compiled.client, null, 2) + '\n',
		})) {
			const destination = resolve(project, path);
			await mkdir(dirname(destination), { recursive: true });
			await writeFile(destination, value);
		}
		console.log(
			`Built client ${relative(project, resolve(project, 'dist/editor.js'))}: ${compiled.client.sourceDigest}`,
		);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1]).catch(() => '')).href) {
	await develop(import.meta.dirname, process.argv.slice(2));
}
