import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { parseAllDocuments } from 'yaml';

const repository = resolve(import.meta.dirname, '../..');
const manifest = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8'));
const specifier = manifest.devDependencies.bun as string;
const executable = join(repository, 'node_modules/bun', process.platform === 'win32' ? 'bun.exe' : 'bun');

test('pnpm installs the pinned native Bun without an npm installer', () => {
	assert.match(specifier, /^runtime:\d+\.\d+\.\d+$/);
	const installed = JSON.parse(readFileSync(join(repository, 'node_modules/bun/package.json'), 'utf8'));
	assert.equal(installed.version, specifier.slice('runtime:'.length));
	assert.equal(installed.scripts?.postinstall, undefined);
	assert.equal(existsSync(join(repository, 'node_modules/bun/install.js')), false);
	for (let attempt = 0; attempt < 2; attempt++) {
		const result = spawnSync(executable, ['--version'], { encoding: 'utf8', windowsHide: true });
		assert.equal(result.status, 0, result.stdout + result.stderr);
		assert.equal(result.stdout.trim(), installed.version);
	}
});

test('the frozen lockfile pins native Bun archives and checksums for supported Desktop platforms', () => {
	// pnpm's first YAML document locks the package manager; the last owns project dependencies.
	const documents = parseAllDocuments(readFileSync(join(repository, 'pnpm-lock.yaml'), 'utf8'));
	for (const document of documents) assert.deepEqual(document.errors, []);
	const lock = documents.at(-1)!.toJS();
	assert.deepEqual(lock.importers['.'].devDependencies.bun, { specifier, version: specifier });
	assert.equal(lock.patchedDependencies?.[`bun@${specifier.slice('runtime:'.length)}`], undefined);
	const runtime = lock.packages[`bun@${specifier}`];
	assert.equal(runtime.resolution.type, 'variations');
	for (const [os, cpu] of [
		['darwin', 'arm64'],
		['darwin', 'x64'],
		['win32', 'arm64'],
		['win32', 'x64'],
		['linux', 'arm64'],
		['linux', 'x64'],
	]) {
		const variant = runtime.resolution.variants.find(
			(entry: { targets: { os: string; cpu: string; libc?: string }[] }) =>
				entry.targets.some(target => target.os === os && target.cpu === cpu && !target.libc),
		);
		assert.ok(variant, `${os} ${cpu}`);
		assert.equal(variant.resolution.type, 'binary');
		assert.match(variant.resolution.integrity, /^sha256-[A-Za-z0-9+/]+=*$/);
		assert.ok(
			variant.resolution.url.startsWith(
				`https://github.com/oven-sh/bun/releases/download/bun-v${runtime.version}/`,
			),
		);
	}
});
