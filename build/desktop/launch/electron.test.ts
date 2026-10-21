import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFile, copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { isProcessRunning, ProcessRun } from '../../processes.ts';

for (const profile of ['default', 'custom'] as const) {
	test(`Electron starts once after valid compilation and restarts only after valid rebuilds (${profile} profile)`, { timeout: process.platform === 'win32' ? 60_000 : 20_000 }, async t => {
		const root = await realpath(await mkdtemp(join(tmpdir(), 'ash-electron-')));
		const desktop = join(root, '.');
		let phaseRevision = 0;
		async function setPhase(phase: string): Promise<void> {
			const temporary = join(desktop, `phase-${phaseRevision++}.tmp`);
			await writeFile(temporary, phase);
			// Publish complete phases so the compiler cannot read a truncated file as a valid build.
			await rename(temporary, join(desktop, 'phase'));
			await appendFile(join(desktop, 'fixture.cjs'), `\n// save ${phaseRevision}\n`);
		}
		for (const directory of ['build/desktop/launch', 'node_modules/@ash/typescript-compiler/bin', 'node_modules/electron', '.build/protocol/typescript', '.build/desktop/localization']) {
			await mkdir(join(root, directory), { recursive: true });
		}
		for (const name of ['build/source-layout.json', 'build/processes.ts', 'build/desktop/launch/electron.ts', 'build/desktop/electron.ts', 'src/ash/code/common/application.ts', 'build/desktop/host.ts', 'build/desktop/paths.ts', 'build/desktop/appServer.ts', 'build/desktop/liveBuild.ts', 'build/python.ts', 'build/protocol/generate.ts', 'build/lib/incrementalOutput.ts']) {
			await mkdir(join(root, name, '..'), { recursive: true });
			await copyFile(resolve(import.meta.dirname, '../../..', name), join(root, name));
		}
		await writeFile(join(root, 'package.json'), '{"type":"module"}');
		await symlink(resolve(import.meta.dirname, '../../../node_modules/typescript'), join(root, 'node_modules/typescript'), process.platform === 'win32' ? 'junction' : 'dir');
		for (const project of ['main', 'preload']) {
			await writeFile(join(root, `tsconfig.${project}.json`), JSON.stringify({ compilerOptions: { incremental: true, outDir: `.build/desktop/${project}`, tsBuildInfoFile: `.build/desktop/${project}.tsbuildinfo` }, files: ['fixture.cjs'] }));
		}
		await writeFile(join(desktop, 'package.json'), '{"main":"fixture.cjs","type":"module"}');
		await writeFile(join(desktop, 'node_modules/electron/index.js'), 'module.exports = process.execPath;');
		await writeFile(join(desktop, 'fixture.cjs'), `
      require('node:fs').appendFileSync('launches.log', JSON.stringify({ pid: process.pid, cwd: process.cwd(), args: process.argv.slice(2), runAsNode: process.env.ELECTRON_RUN_AS_NODE, home: process.env.ASH_HOME }) + '\\n');
      process.on('SIGTERM', () => {
        require('node:fs').appendFileSync('stops.log', process.pid + '\\n');
        setTimeout(() => process.exit(0), 750);
      });
      setInterval(() => {}, 1000);
    `);
		await writeFile(join(desktop, 'node_modules/@ash/typescript-compiler/bin/tsc'), `
      const fs = require('node:fs');
      const path = require('node:path');
      if (fs.existsSync('compiler-active')) throw new Error('Concurrent Host compilers');
      fs.writeFileSync('compiler-active', String(process.pid));
      fs.appendFileSync('compilers.log', JSON.stringify({ pid: process.pid, cwd: process.cwd(), args: process.argv.slice(2) }) + '\\n');
        const phase = fs.readFileSync('phase', 'utf8');
        fs.appendFileSync('started.log', phase + '\\n');
      setTimeout(() => {
        const output = '.build/desktop/preload/src/ash/base/parts/sandbox/electron-browser/preload.cjs';
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.writeFileSync(output, phase === 'initial' || phase === 'invalid' ? "require('fs')" : "require('electron')");
        const browserOutput = '.build/desktop/preload/src/ash/platform/browserView/electron-browser/preload-browserView.js';
        fs.mkdirSync(path.dirname(browserOutput), { recursive: true });
        fs.writeFileSync(browserOutput, "require('electron'); // " + (phase === 'preload' ? 'updated' : 'initial'));
        const mainOutput = '.build/desktop/main/src/main.js';
        fs.mkdirSync(path.dirname(mainOutput), { recursive: true });
        fs.writeFileSync(mainOutput, 'export const version = ' + (phase.startsWith('recovered') || phase === 'preload' ? 2 : 1));
        fs.appendFileSync('phases.log', phase + '\\n');
        fs.unlinkSync('compiler-active');
        process.exitCode = phase === 'error' ? 1 : 0;
      }, phase === 'slow' ? 600 : 0);
    `);
		await setPhase('initial');
		const home = join(root, profile === 'custom' ? 'custom-profile' : '.build/desktop/dev/profile');
		const userData = join(root, profile === 'custom' ? 'custom-user-data' : '.build/desktop/dev/user-data');
		const child = spawn(process.execPath, [join(root, 'build/desktop/launch/electron.ts'), '--watch', '--fixture', ...(profile === 'custom' ? [`--user-data-dir=${userData}`] : [])], {
			cwd: tmpdir(), windowsHide: true, stdio: 'pipe', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ASH_DESKTOP_UI_ONLY: '1', ASH_HOME: profile === 'custom' ? home : undefined },
		});
		let output = '';
		child.stdout.on('data', chunk => { output += chunk; });
		child.stderr.on('data', chunk => { output += chunk; });
		const closed = new Promise(resolvePromise => child.once('close', resolvePromise));
		const run = new ProcessRun(root, undefined, 5_000);
		t.after(async () => {
			await run.stop('SIGTERM');
			await closed;
			await rm(root, { recursive: true, force: true });
		});
		await run.own(child);
		async function lines(file: string): Promise<string[]> {
			const text = await readFile(join(desktop, file), 'utf8').catch(error => {
				if (error.code !== 'ENOENT') throw error;
				return '';
			});
			return text.trim().split('\n').filter(Boolean);
		}
		async function until(predicate: () => Promise<boolean> | boolean): Promise<void> {
			const deadline = Date.now() + (process.platform === 'win32' ? 15_000 : 6_000);
			while (Date.now() < deadline) {
				if (await predicate()) return;
				assert.equal(child.exitCode, null, output);
				await delay(50);
			}
			assert.fail(output);
		}
		await until(() => output.includes('unsupported runtime imports: fs'));
		assert.deepEqual(await lines('launches.log'), []);
		await setPhase('valid');
		await until(async () => (await lines('launches.log')).length === 1);
		const compilers = (await lines('compilers.log')).map(line => JSON.parse(line));
		assert.equal(compilers.length, 2);
		for (const compiler of compilers) {
			assert.equal(compiler.cwd, desktop);
			assert.ok(!compiler.args.includes('--watch'), 'Only the input watcher owns filesystem subscriptions');
			assert.deepEqual(compiler.args.slice(0, 3), ['--build', 'tsconfig.main.json', 'tsconfig.preload.json']);
		}
		await setPhase('unchanged');
		await until(async () => (await lines('phases.log')).includes('unchanged'));
		await delay(300);
		assert.equal((await lines('launches.log')).length, 1, 'Rewriting unchanged compiler outputs must not restart Electron');
		await setPhase('slow');
		await until(async () => (await lines('started.log')).includes('slow'));
		await setPhase('valid-after-slow');
		await until(async () => (await lines('phases.log')).includes('valid-after-slow'));
		assert.equal((await lines('launches.log')).length, 1, 'A save during compilation queues a build without starting another compiler or restarting unchanged output');
		for (const phase of ['error', 'invalid']) {
			output = '';
			await setPhase(phase);
			await until(async () => (await lines('phases.log')).includes(phase));
			if (phase === 'invalid') await until(() => output.includes('unsupported runtime imports: fs'));
			await delay(300);
			assert.equal((await lines('launches.log')).length, 1);
		}
		await setPhase('recovered');
		if (process.platform === 'win32') {
			// Windows termination cannot run the fixture's POSIX signal handler.
			const [{ pid }] = (await lines('launches.log')).map(line => JSON.parse(line));
			await until(() => !isProcessRunning(pid));
		} else {
			await until(async () => (await lines('stops.log')).length === 1);
		}
		// A no-op build while the old process exits must not cancel the pending replacement.
		await setPhase('recovered-unchanged');
		await until(async () => (await lines('launches.log')).length === 2);
		await setPhase('preload');
		await until(async () => (await lines('launches.log')).length === 3);
		const launches = (await lines('launches.log')).map(line => JSON.parse(line));
		const allCompilers = (await lines('compilers.log')).map(line => JSON.parse(line));
		assert.ok(allCompilers.length >= 7);
		for (const { pid, ...launch } of launches) {
			assert.ok(pid > 0);
			assert.deepEqual(launch, { cwd: desktop, args: ['--fixture', `--user-data-dir=${userData}`], home });
		}
		await run.stop('SIGTERM');
		await closed;
		if (process.platform === 'win32') assert.equal(child.signalCode, 'SIGTERM');
		else assert.equal(child.exitCode, 143, 'Stopping the launch task closes its input watcher and active processes');
		for (const { pid } of [...launches, ...allCompilers]) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
	});
}
