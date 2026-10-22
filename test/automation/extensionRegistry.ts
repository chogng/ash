import { createHash, createPrivateKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer, type Server } from 'node:https';
import type { BackendFixture } from './test.js';

interface Release {
	readonly version: string;
	readonly digest: string;
	readonly archive: Buffer;
	readonly manifest: Record<string, unknown>;
	readonly fileCount: number;
	readonly size: number;
}

/** A test-owned signed HTTPS distribution, consumed by the real Rust registry and package manager. */
export class SignedExtensionRegistry implements BackendFixture {
	public readonly productServicesPath: string;
	public readonly releases: readonly Release[];
	private profileDirectory: string | undefined;
	private publishedRelease = 1;
	private server: Server | undefined;
	public readonly requests: { path: string; release: number; status: number; bytes: number; }[] = [];

	private constructor(private readonly root: string, releases: readonly Release[], public readonly packageId = 'ash.language-pack-zh-cn@ash', private readonly productRuntimePublishers: readonly string[] = []) {
		this.productServicesPath = join(root, 'product-services.json');
		this.releases = releases;
	}

	public static async createLanguagePack(root: string): Promise<SignedExtensionRegistry> {
		await mkdir(root, { recursive: true });
		const files = await readTree(resolve('.build/desktop/localization/extensions/ash.language-pack-zh-cn'));
		const releases = ['2.0.0', '3.0.0'].map((version, index) => {
			const contents = new Map(files);
			const manifest = JSON.parse(contents.get('manifest.json')!.toString());
			manifest.version = version;
			contents.set('manifest.json', Buffer.from(JSON.stringify(manifest)));
			const extension = JSON.parse(contents.get('package.json')!.toString());
			extension.version = version;
			contents.set('package.json', Buffer.from(JSON.stringify(extension)));
			const catalog = JSON.parse(contents.get('localization/package.json')!.toString());
			catalog.bundles['ash.regions'].searchCommands = index === 0 ? '安装版搜索命令' : '更新版搜索命令';
			catalog.extensionTranslations['ash.git'].package['git.menu.createBranch'] = index === 0 ? '安装版创建分支…' : '更新版创建分支…';
			// A partial installed catalog must retain the caller's English fallback.
			delete catalog.bundles['ash.regions'].primarySidebar;
			contents.set('localization/package.json', Buffer.from(JSON.stringify(catalog)));
			const digest = createHash('sha256').update('marketplace-package-v1\0');
			let size = 0;
			for (const [path, bytes] of [...contents].sort(([left], [right]) => left < right ? -1 : 1)) {
				digest.update(lengthBytes(Buffer.byteLength(path))).update(path).update(lengthBytes(bytes.length)).update(bytes);
				size += bytes.length;
			}
			return { version, digest: 'sha256:' + digest.digest('hex'), archive: zip(contents), manifest, fileCount: contents.size, size };
		});
		const key = generateKeyPairSync('ed25519');
		const publicKey = { keytype: 'ed25519', scheme: 'ed25519', keyval: { public: key.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex') } };
		const keyId = sha256(Buffer.from(canonical(publicKey)));
		const expires = new Date(Date.now() + 7 * 86_400_000).toISOString();
		const envelope = (signed: Record<string, unknown>): Buffer => signedMetadata(signed, keyId, key.privateKey);
		const role = { keyids: [keyId], threshold: 1 };
		const trustedRoot = envelope({ _type: 'root', spec_version: '1.0.0', version: 1, expires, consistent_snapshot: false, keys: { [keyId]: publicKey }, roles: { root: role, targets: role, snapshot: role, timestamp: role } });
		await writeFile(join(root, 'root.json'), trustedRoot);
		for (const count of [1, 2]) {
			const repository = join(root, `release-${count}`);
			const metadata = join(repository, 'metadata');
			const targetsDirectory = join(repository, 'targets');
			await mkdir(metadata, { recursive: true });
			await mkdir(join(targetsDirectory, 'packages', 'ash', 'language-pack-zh-cn'), { recursive: true });
			await mkdir(join(targetsDirectory, 'marketplace'), { recursive: true });
			await writeFile(join(metadata, '1.root.json'), trustedRoot);
			const targets: Record<string, unknown> = {};
			for (const release of releases.slice(0, count)) {
				const target = `packages/ash/language-pack-zh-cn/${release.version}.zip`;
				await writeFile(join(targetsDirectory, target), release.archive);
				targets[target] = {
					...fileMetadata(release.archive),
					custom: {
						marketplacePackage: { schemaVersion: 1, id: 'ash/language-pack-zh-cn', version: release.version, packageDigest: release.digest },
						marketplaceCatalog: { schemaVersion: 1, manifest: release.manifest, packageFileCount: release.fileCount, packageSizeBytes: release.size },
					},
				};
			}
			const publisher = envelope({ _type: 'targets', spec_version: '1.0.0', version: count, expires, targets });
			await writeFile(join(metadata, 'publishers%2Fash.json'), publisher);
			const revocations = Buffer.from(JSON.stringify({ schemaVersion: 1, revoked: [] }));
			await writeFile(join(targetsDirectory, 'marketplace', 'revocations.json'), revocations);
			const topTargets = envelope({
				_type: 'targets', spec_version: '1.0.0', version: count, expires,
				targets: { 'marketplace/revocations.json': fileMetadata(revocations) },
				delegations: { keys: { [keyId]: publicKey }, roles: [{ name: 'publishers/ash', ...role, terminating: true, paths: ['packages/ash/*'] }] },
			});
			await writeFile(join(metadata, 'targets.json'), topTargets);
			const snapshot = envelope({ _type: 'snapshot', spec_version: '1.0.0', version: count, expires, meta: { 'targets.json': { version: count, ...fileMetadata(topTargets) }, 'publishers/ash.json': { version: count, ...fileMetadata(publisher) } } });
			await writeFile(join(metadata, 'snapshot.json'), snapshot);
			await writeFile(join(metadata, 'timestamp.json'), envelope({ _type: 'timestamp', spec_version: '1.0.0', version: count, expires, meta: { 'snapshot.json': { version: count, ...fileMetadata(snapshot) } } }));
		}
		const registry = new SignedExtensionRegistry(root, releases);
		try { await registry.start(); } catch (error) { await registry.close(); throw error; }
		return registry;
	}

	/** Serves a separately built signed editor submission; installation and exact consent stay product actions. */
	public static async createEditor(root: string, distribution: string, trustedRoot: string, packageId: string): Promise<SignedExtensionRegistry> {
		await mkdir(root, { recursive: true });
		await cp(distribution, join(root, 'release-1'), { recursive: true, errorOnExist: true, force: false });
		await writeFile(join(root, 'root.json'), await readFile(trustedRoot));
		const registry = new SignedExtensionRegistry(root, [], packageId, ['ash']);
		try { await registry.start(); } catch (error) { await registry.close(); throw error; }
		return registry;
	}

	public async prepareProfile(profileDirectory: string): Promise<void> {
		this.profileDirectory = profileDirectory;
	}

	public publishUpdate(): void { this.publishedRelease = 2; }

	public async installations(): Promise<readonly { installationId: string; package: { id: string; version: string; digest: string; }; state: string; capabilities: readonly { descriptor: { kind: string; }; }[]; }[]> {
		const state = JSON.parse(await readFile(join(this.profileDirectory!, 'extensions-manager', 'manager-state.json'), 'utf8'));
		return Object.values(state.installations);
	}

	public async installedCatalog(version: string): Promise<unknown> {
		const release = this.releases.find(release => release.version === version)!;
		return JSON.parse(await readFile(join(this.profileDirectory!, 'extensions-manager', 'artifacts', release.digest.slice('sha256:'.length), 'localization', 'package.json'), 'utf8'));
	}

	private async start(): Promise<void> {
		const fixtureRoot = resolve('crates/http-test-support/fixtures');
		const [ca, certificate, privateKey] = await Promise.all([
			readFile(join(fixtureRoot, 'ca.der')), readFile(join(fixtureRoot, 'server.der')), readFile(join(fixtureRoot, 'server-key.der')),
		]);
		await writeFile(join(this.root, 'tls-ca.der'), ca);
		const cert = '-----BEGIN CERTIFICATE-----\n' + certificate.toString('base64').match(/.{1,64}/gu)!.join('\n') + '\n-----END CERTIFICATE-----\n';
		const key = createPrivateKey({ key: privateKey, type: 'pkcs8', format: 'der' });
		this.server = createServer({ cert, key: key.export({ type: 'pkcs8', format: 'pem' }) }, async (request, response) => {
			const path = request.url ?? '';
			const release = this.publishedRelease;
			// Serve only generated repository entries; TUF role URLs retain encoded slashes.
			if (request.method !== 'GET' || !/^\/(metadata|targets)\/[a-zA-Z0-9%._/-]+$/u.test(path) || path.split('/').includes('..')) {
				response.writeHead(400).end(); return;
			}
			try {
				const bytes = await readFile(join(this.root, `release-${release}`, path.slice(1)));
				this.requests.push({ path, release, status: 200, bytes: bytes.length });
				response.writeHead(200, { 'Content-Length': bytes.length, 'Content-Type': path.endsWith('.zip') ? 'application/zip' : 'application/json' }).end(bytes);
			} catch (error) {
				const status = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 500;
				this.requests.push({ path, release, status, bytes: 0 });
				response.writeHead(status).end();
			}
		});
		await new Promise<void>((resolve, reject) => { this.server!.once('error', reject); this.server!.listen(0, '127.0.0.1', resolve); });
		const address = this.server.address();
		if (!address || typeof address === 'string') { throw new Error('HTTPS registry did not bind a TCP port'); }
		const origin = `https://127.0.0.1:${address.port}`;
		await writeFile(this.productServicesPath, JSON.stringify({
			schemaVersion: 3,
			extensionSources: [{ name: 'ash', metadataBaseUrl: origin + '/metadata/', targetsBaseUrl: origin + '/targets/', trustedRoot: 'root.json', tlsRootCertificates: ['tls-ca.der'], allowedPublishers: ['ash'], ...(this.productRuntimePublishers.length ? { productRuntimePublishers: this.productRuntimePublishers } : {}) }],
		}));
	}

	public async close(): Promise<void> {
		if (this.server?.listening) {
			const server = this.server;
			await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
		}
	}

}

async function readTree(root: string, prefix = ''): Promise<Map<string, Buffer>> {
	const files = new Map<string, Buffer>();
	for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
		const path = prefix + entry.name;
		if (entry.isDirectory()) {
			for (const [childPath, bytes] of await readTree(root, path + '/')) { files.set(childPath, bytes); }
		} else { files.set(path, await readFile(join(root, path))); }
	}
	return files;
}

function canonical(value: unknown): string {
	if (typeof value === 'string') { return '"' + value.normalize('NFC').replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"'; }
	if (Array.isArray(value)) { return '[' + value.map(canonical).join(',') + ']'; }
	if (value !== null && typeof value === 'object') {
		return '{' + Object.entries(value).sort(([left], [right]) => left < right ? -1 : 1).map(([key, item]) => canonical(key) + ':' + canonical(item)).join(',') + '}';
	}
	return JSON.stringify(value);
}

function signedMetadata(signed: Record<string, unknown>, keyId: string, key: KeyObject): Buffer {
	return Buffer.from(JSON.stringify({ signed, signatures: [{ keyid: keyId, sig: sign(null, Buffer.from(canonical(signed)), key).toString('hex') }] }));
}

function sha256(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
function fileMetadata(bytes: Buffer): { length: number; hashes: { sha256: string; }; } { return { length: bytes.length, hashes: { sha256: sha256(bytes) } }; }
function lengthBytes(length: number): Buffer { const bytes = Buffer.alloc(8); bytes.writeBigUInt64BE(BigInt(length)); return bytes; }

/** ZIP with stored entries keeps fixtures independent of shell tools and compression libraries. */
function zip(files: ReadonlyMap<string, Buffer>): Buffer {
	const entries: Buffer[] = [];
	const directory: Buffer[] = [];
	let offset = 0;
	for (const [path, data] of files) {
		const name = Buffer.from(path);
		let crc = 0xffffffff;
		for (const byte of data) {
			crc ^= byte;
			for (let bit = 0; bit < 8; bit++) { crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
		}
		crc = (crc ^ 0xffffffff) >>> 0;
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
		local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
		entries.push(local, name, data);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8);
		central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
		directory.push(central, name);
		offset += local.length + name.length + data.length;
	}
	const central = Buffer.concat(directory);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.size, 8); end.writeUInt16LE(files.size, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
	return Buffer.concat([...entries, central, end]);
}
