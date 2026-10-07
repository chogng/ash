import { strict as assert } from 'node:assert';
import { execFile, spawn } from 'node:child_process';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pythonCommand } from '../python.ts';

type Product = 'ash-desktop' | 'ash-code' | 'ash-app-server';
export interface ReleaseIdentity { product: Product; version: string; target: string; }
interface ReleasePackage { fileName: string; format: string; size: number; sha256: string; url: string; }
const root = resolve(import.meta.dirname, '../..');
const runFile = promisify(execFile);
const hosts = [
	{ runner: 'macos-26', target: 'aarch64-apple-darwin', platform: 'darwin', arch: 'arm64' },
	{ runner: 'macos-26-intel', target: 'x86_64-apple-darwin', platform: 'darwin', arch: 'x64' },
	{ runner: 'ubuntu-24.04-arm', target: 'aarch64-unknown-linux-gnu', platform: 'linux', arch: 'arm64' },
	{ runner: 'ubuntu-24.04', target: 'x86_64-unknown-linux-gnu', platform: 'linux', arch: 'x64' },
	{ runner: 'windows-11-arm', target: 'aarch64-pc-windows-msvc', platform: 'win32', arch: 'arm64' },
	{ runner: 'windows-latest', target: 'x86_64-pc-windows-msvc', platform: 'win32', arch: 'x64' },
] as const;
const products: Product[] = ['ash-desktop', 'ash-code', 'ash-app-server'];

export function releaseMatrix(product: Product | 'all') {
	assert(product === 'all' || products.includes(product), 'Unknown release product');
	return (product === 'all' ? products : [product]).flatMap(product => hosts
		.filter(host => product !== 'ash-desktop' || host.platform === 'darwin' || (host.platform === 'win32' && host.arch === 'x64'))
		.map(host => ({ ...host, product })));
}

export function releaseAsset(identity: ReleaseIdentity): { archive: string; format: string; descriptor: string; } {
	assert.match(identity.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'Expected a release version without v');
	const host = releaseMatrix(identity.product).find(host => host.target === identity.target);
	assert(host, 'Unsupported product target');
	const archive = identity.product === 'ash-desktop'
		? host.platform === 'darwin' ? `Ash-darwin-${host.arch}.zip` : `AshSetup-${identity.version}-win32-x64.exe`
		: `${identity.product}-${identity.target}.${host.platform === 'darwin' ? 'zip' : 'tar.gz'}`;
	return { archive, format: archive.endsWith('.exe') ? 'windowsExe' : archive.endsWith('.zip') ? 'zip' : 'tarGz', descriptor: `${identity.product}-${identity.target}.update.json` };
}

/** Bind the tested bytes to the same signed release users download. */
export function verifyDescriptor(document: string, publicKey: string, identity: ReleaseIdentity): ReleasePackage {
	assert.match(publicKey, /^[a-fA-F0-9]{64}$/, 'ASH_UPDATE_PUBLIC_KEY is required');
	const envelope = JSON.parse(document);
	assert.equal(typeof envelope.payload, 'string');
	assert.equal(typeof envelope.signature, 'string');
	const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKey, 'hex')]), format: 'der', type: 'spki' });
	assert(verify(null, Buffer.from(envelope.payload), key, Buffer.from(envelope.signature, 'base64')), 'Release signature is invalid');
	const payload = JSON.parse(envelope.payload);
	const asset = releaseAsset(identity);
	assert.deepEqual(
		[payload.schemaVersion, payload.product, payload.channel, payload.version, payload.releaseIdentity, payload.target, payload.package.fileName, payload.package.format, payload.package.url],
		[1, { 'ash-desktop': 'electronDesktop', 'ash-code': 'ashCode', 'ash-app-server': 'appServer' }[identity.product], 'latest', identity.version, `v${identity.version}`, identity.target, asset.archive, asset.format, `https://github.com/chogng/ash/releases/download/v${identity.version}/${asset.archive}`],
		'Signed release does not match the requested artifact',
	);
	assert(Number.isSafeInteger(payload.package.size) && payload.package.size > 0 && payload.package.size <= 4 * 1024 ** 3, 'Invalid package size');
	assert.match(payload.package.sha256, /^[a-f0-9]{64}$/);
	return payload.package;
}

export async function sha256(path: string): Promise<string> {
	const hash = createHash('sha256');
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest('hex');
}

export async function verifyArchive(path: string, expected: Pick<ReleasePackage, 'size' | 'sha256'>): Promise<void> {
	assert.equal((await stat(path)).size, expected.size, 'Archive size differs from signed release');
	assert.equal(await sha256(path), expected.sha256, 'Archive digest differs from signed release');
}

/** Promotion rechecks the archive after download, so changed assets cannot reuse a passing report. */
export async function verifyAttestation(reportPath: string, archivePath: string, identity: ReleaseIdentity): Promise<void> {
	const report = JSON.parse(await readFile(reportPath, 'utf8'));
	assert.deepEqual([report.status, report.product, report.version, report.target, report.archive], ['passed', identity.product, identity.version, identity.target, releaseAsset(identity).archive], 'Missing passing sanity report for this release');
	if (identity.product === 'ash-desktop') assert.equal(report.upgrade, 'passed', 'Desktop promotion requires an upgrade check');
	await verifyArchive(archivePath, { size: report.size, sha256: report.sha256 });
}

async function run(program: string, args: string[], env = process.env): Promise<void> {
	await new Promise<void>((done, fail) => {
		const child = spawn(program, args, { cwd: root, stdio: 'inherit', windowsHide: true, env });
		child.once('error', fail);
		child.once('close', (code, signal) => code === 0 ? done() : fail(new Error(`${program} ${signal ?? `exited with ${code}`}`)));
	});
}

async function loadArtifact(identity: ReleaseIdentity, directory: string, download: boolean): Promise<{ archive: string; descriptor: ReleasePackage; }> {
	const asset = releaseAsset(identity);
	await mkdir(directory, { recursive: true });
	if (download) await run('gh', ['release', 'download', `v${identity.version}`, '--repo', 'chogng/ash', '--pattern', asset.archive, '--pattern', asset.descriptor, '--dir', directory]);
	const descriptor = verifyDescriptor(await readFile(join(directory, asset.descriptor), 'utf8'), process.env.ASH_UPDATE_PUBLIC_KEY ?? '', identity);
	const archive = join(directory, asset.archive);
	await verifyArchive(archive, descriptor);
	return { archive, descriptor };
}

async function extract(archive: string, directory: string): Promise<void> {
	await mkdir(directory);
	if (process.platform === 'darwin' && archive.endsWith('.zip')) await run('ditto', ['-x', '-k', archive, directory]);
	else await run('tar', ['-xf', archive, '-C', directory]);
}

async function verifyRuntime(identity: ReleaseIdentity, archive: string, directory: string, output: string): Promise<void> {
	await extract(archive, directory);
	const metadata = JSON.parse(await readFile(join(directory, 'ash-package.json'), 'utf8'));
	assert.deepEqual([metadata.version, metadata.target, metadata.javascriptRuntime], [identity.version, identity.target, { kind: 'packagedNode' }]);
	assert.equal('cli' in metadata.components, identity.product === 'ash-code');
	const integrity = pythonCommand(['-B', '-c', [
		'from pathlib import Path',
		'import sys',
		'from build.lib.targets import target_spec',
		'from build.lib.package import validate_package_directory, require_verified_system_signing, system_signing_artifacts',
		'from build.lib.signing import run_command, verify_command',
		'package, spec = Path(sys.argv[1]), target_spec(sys.argv[2])',
		'validate_package_directory(package, spec)',
		'require_verified_system_signing(package, spec)',
		'if not spec.is_linux:',
		'    for artifact in system_signing_artifacts(package, spec).values():',
		'        run_command(verify_command(artifact, spec.operating_system.value))',
	].join('\n'), directory, identity.target]);
	await run(integrity.command, integrity.args);
	const suffix = process.platform === 'win32' ? '.exe' : '';
	if (identity.product === 'ash-code') {
		const result = await runFile(join(directory, 'bin', `ash${suffix}`), ['--version'], { timeout: 30_000, windowsHide: true });
		assert.equal(result.stdout.trim(), `ash ${identity.version}`);
	}
	// Reuse the package's RPC lifecycle and search checks, including missing host search tools.
	const python = pythonCommand(['-B', 'build/search_smoke.py', '--package-dir', directory, '--report', join(output, 'search.json')]);
	await run(python.command, python.args);
}

async function verifyDesktop(identity: ReleaseIdentity, archive: string, previous: { archive: string; version: string; } | undefined, output: string): Promise<void> {
	const cli = join(root, 'node_modules/@playwright/test/cli.js');
	await run(process.execPath, [cli, 'test', '--config', 'playwright.config.ts', 'test/smoke/areas/windows/release-package.spec.ts', '--project=electron-release', '--output', join(output, 'playwright')], {
		...process.env,
		ASH_RELEASE_ARCHIVE: archive,
		ASH_RELEASE_VERSION: identity.version,
		ASH_RELEASE_PREVIOUS_ARCHIVE: previous?.archive,
		ASH_RELEASE_PREVIOUS_VERSION: previous?.version,
		PLAYWRIGHT_HTML_OUTPUT_DIR: join(output, 'html-report'),
	});
}

function parseOptions(args: string[]): Map<string, string> {
	const options = new Map<string, string>();
	for (let i = 0; i < args.length; i += 2) {
		assert(args[i].startsWith('--') && args[i + 1] && !options.has(args[i].slice(2)), `Invalid option ${args[i]}`);
		options.set(args[i].slice(2), args[i + 1]);
	}
	return options;
}

async function main(args: string[]): Promise<void> {
	const [command, ...arguments_] = args;
	assert(['matrix', 'verify', 'attest'].includes(command), 'Usage: sanity.ts matrix|verify|attest --product PRODUCT [--version VERSION --target TARGET]');
	const options = parseOptions(arguments_);
	const allowed = command === 'matrix' ? ['product'] : command === 'attest' ? ['product', 'version', 'target', 'report', 'archive'] : ['product', 'version', 'target', 'output', 'artifacts-dir', 'previous-version', 'previous-artifacts-dir'];
	for (const key of options.keys()) assert(allowed.includes(key), `Unknown option --${key}`);
	const product = options.get('product') as Product;
	if (command === 'matrix') { console.log(JSON.stringify(releaseMatrix(product))); return; }
	const identity: ReleaseIdentity = { product, version: options.get('version')!, target: options.get('target')! };
	releaseAsset(identity);
	if (command === 'attest') { await verifyAttestation(resolve(options.get('report')!), resolve(options.get('archive')!), identity); return; }
	const host = hosts.find(host => host.target === identity.target)!;
	assert.deepEqual([process.platform, process.arch], [host.platform, host.arch], 'Sanity must run on the artifact target OS and CPU');
	const previousVersion = options.get('previous-version');
	assert(!options.has('previous-artifacts-dir') || previousVersion, 'Previous artifacts require --previous-version');
	if (previousVersion) {
		assert.equal(product, 'ash-desktop', 'Installation upgrade checks belong to Desktop');
		releaseAsset({ ...identity, version: previousVersion });
		const previous = previousVersion.split('.').map(Number), candidate = identity.version.split('.').map(Number);
		const different = previous.findIndex((part, index) => part !== candidate[index]);
		assert(different !== -1 && previous[different] < candidate[different], 'Previous version must be older than the candidate');
	}
	const output = resolve(options.get('output')!);
	await mkdir(output, { recursive: true });
	const report: Record<string, unknown> = { ...identity, status: 'failed', upgrade: previousVersion ? 'failed' : 'not-requested', previousVersion };
	// Keep profile sockets short and preserve reports outside the disposable installation.
	const temporary = await mkdtemp(join(tmpdir(), 'ash-sanity-'));
	try {
		const artifact = await loadArtifact(identity, resolve(options.get('artifacts-dir') ?? join(temporary, 'candidate')), !options.has('artifacts-dir'));
		Object.assign(report, { archive: basename(artifact.archive), size: artifact.descriptor.size, sha256: artifact.descriptor.sha256 });
		if (product === 'ash-desktop') {
			if (process.platform === 'win32') await run('signtool', ['verify', '/pa', '/all', '/v', artifact.archive]);
			const previous = previousVersion ? await loadArtifact({ ...identity, version: previousVersion }, resolve(options.get('previous-artifacts-dir') ?? join(temporary, 'previous')), !options.has('previous-artifacts-dir')) : undefined;
			if (previous && process.platform === 'win32') await run('signtool', ['verify', '/pa', '/all', '/v', previous.archive]);
			await verifyDesktop(identity, artifact.archive, previous && { archive: previous.archive, version: previousVersion! }, output);
			if (previous) report.upgrade = 'passed';
		} else await verifyRuntime(identity, artifact.archive, join(temporary, 'package'), output);
		report.status = 'passed';
	} catch (error) {
		report.error = String(error);
		throw error;
	} finally {
		await writeFile(join(output, `${product}-${identity.target}.json`), `${JSON.stringify(report, null, 2)}\n`);
		const directory = await realpath(temporary);
		assert.equal(dirname(directory), await realpath(tmpdir()), 'Sanity cleanup must stay in its temporary directory');
		assert(basename(directory).startsWith('ash-sanity-'));
		await rm(directory, { recursive: true, force: true });
	}
}

if (import.meta.main) await main(process.argv.slice(2));
