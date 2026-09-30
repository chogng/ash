import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { releaseAsset, releaseMatrix, verifyArchive, verifyAttestation, verifyDescriptor, type ReleaseIdentity } from './sanity.ts';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const key = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
const identity: ReleaseIdentity = { product: 'ash-code', version: '1.2.3', target: 'x86_64-pc-windows-msvc' };

function descriptor(changes: Record<string, unknown> = {}): string {
	const asset = releaseAsset(identity);
	const payload = JSON.stringify({
		schemaVersion: 1, product: 'ashCode', channel: 'latest', version: identity.version, releaseIdentity: 'v1.2.3', target: identity.target,
		package: { fileName: asset.archive, format: asset.format, size: 3, sha256: createHash('sha256').update('ash').digest('hex'), url: `https://github.com/chogng/ash/releases/download/v1.2.3/${asset.archive}` },
		...changes,
	});
	return JSON.stringify({ payload, signature: sign(null, Buffer.from(payload), privateKey).toString('base64') });
}

test('every distributed target gets its own OS and CPU runtime check', () => {
	const matrix = releaseMatrix('all');
	assert.equal(matrix.length, 15);
	assert.deepEqual(matrix.filter(row => row.product === 'ash-desktop').map(row => row.target), ['aarch64-apple-darwin', 'x86_64-apple-darwin', 'x86_64-pc-windows-msvc']);
	for (const product of ['ash-code', 'ash-app-server'] as const) {
		assert.equal(matrix.filter(row => row.product === product).length, 6);
		assert.equal(matrix.find(row => row.product === product && row.target === 'aarch64-pc-windows-msvc')?.runner, 'windows-11-arm');
	}
	assert.throws(() => releaseAsset({ ...identity, product: 'ash-desktop', target: 'aarch64-pc-windows-msvc' }), /Unsupported/);
	assert.throws(() => releaseAsset({ ...identity, version: '../1.2.3' }), /release version/);
});

test('signed artifact identity must match version, product, target, channel and exact download', () => {
	const package_ = verifyDescriptor(descriptor(), key, identity);
	assert.equal(package_.fileName, 'ash-code-x86_64-pc-windows-msvc.tar.gz');
	for (const changes of [{ version: '2.0.0' }, { product: 'appServer' }, { target: 'aarch64-pc-windows-msvc' }, { channel: 'stable' }, { releaseIdentity: 'v9.0.0' }, { package: { ...package_, url: 'https://example.com/ash.tar.gz' } }, { package: { ...package_, fileName: '../ash.tar.gz' } }, { package: { ...package_, format: 'zip' } }]) {
		assert.throws(() => verifyDescriptor(descriptor(changes), key, identity), /does not match/);
	}
	const tampered = JSON.parse(descriptor());
	tampered.payload = tampered.payload.replace('1.2.3', '1.2.4');
	assert.throws(() => verifyDescriptor(JSON.stringify(tampered), key, identity), /signature/);
	assert.throws(() => verifyDescriptor(descriptor(), '01'.repeat(32), identity), /signature/);
});

test('archive verification rejects truncated and modified delivered bytes', async t => {
	const directory = await mkdtemp(join(tmpdir(), 'ash-sanity-test-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const path = join(directory, 'archive');
	const expected = verifyDescriptor(descriptor(), key, identity);
	await writeFile(path, 'ash');
	await verifyArchive(path, expected);
	await writeFile(path, 'as');
	await assert.rejects(verifyArchive(path, expected), /size/);
	await writeFile(path, 'bad');
	await assert.rejects(verifyArchive(path, expected), /digest/);
});

test('promotion rejects failed checks, reports for other releases and changed assets', async t => {
	const directory = await mkdtemp(join(tmpdir(), 'ash-sanity-test-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const archive = join(directory, 'archive'), reportPath = join(directory, 'report.json');
	await writeFile(archive, 'ash');
	const package_ = verifyDescriptor(descriptor(), key, identity);
	const report = { ...identity, status: 'passed', archive: package_.fileName, size: package_.size, sha256: package_.sha256 };
	await writeFile(reportPath, JSON.stringify(report));
	await verifyAttestation(reportPath, archive, identity);
	for (const changes of [{ status: 'failed' }, { target: 'aarch64-pc-windows-msvc' }, { version: '1.2.4' }]) {
		await writeFile(reportPath, JSON.stringify({ ...report, ...changes }));
		await assert.rejects(verifyAttestation(reportPath, archive, identity), /Missing passing/);
	}
	await writeFile(reportPath, JSON.stringify(report));
	await writeFile(archive, 'bad');
	await assert.rejects(verifyAttestation(reportPath, archive, identity), /digest/);
});

test('Desktop cannot become stable without an installation upgrade check', async t => {
	const directory = await mkdtemp(join(tmpdir(), 'ash-sanity-test-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const desktop: ReleaseIdentity = { ...identity, product: 'ash-desktop' };
	const archive = join(directory, 'archive'), reportPath = join(directory, 'report.json');
	await writeFile(archive, 'ash');
	const report = { ...desktop, status: 'passed', upgrade: 'not-requested', archive: releaseAsset(desktop).archive, size: 3, sha256: createHash('sha256').update('ash').digest('hex') };
	await writeFile(reportPath, JSON.stringify(report));
	await assert.rejects(verifyAttestation(reportPath, archive, desktop), /requires an upgrade/);
	await writeFile(reportPath, JSON.stringify({ ...report, upgrade: 'passed' }));
	await verifyAttestation(reportPath, archive, desktop);
});
