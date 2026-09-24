import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

export function developmentArtifactsPath(appPath: string, ...segments: readonly string[]): string {
	return resolve(appPath, '..', '.build', 'app-ts', ...segments);
}

export function developmentAshPackagePath(appPath: string, runtime: 'host-provided-node' | 'packaged-node' = 'host-provided-node'): string {
	const developmentRoot = resolve(appPath, '..', '.build', 'runtime', 'dev', 'store-v1', developmentHostTarget(), runtime, 'dev-small');
	const manifestDirectory = resolve(developmentRoot, 'manifests');
	const manifestName = readdirSync(manifestDirectory).filter(name => /^\d{20}\.json$/u.test(name)).sort().at(-1);
	if (!manifestName) throw new Error(`Ash development package has no published manifest: ${manifestDirectory}`);
	const manifestPath = resolve(manifestDirectory, manifestName);
	const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
	const sequence = Number(manifestName.slice(0, 20));
	if (!isPackageManifest(manifest, sequence)) throw new Error(`Invalid Ash development package manifest: ${manifestPath}`);
	return resolve(developmentRoot, ...manifest.directory.split('/'));
}

function developmentHostTarget(platform: NodeJS.Platform = process.platform, architecture: string = process.arch): string {
	const targets: Readonly<Record<string, string>> = {
		'darwin-arm64': 'aarch64-apple-darwin',
		'darwin-x64': 'x86_64-apple-darwin',
		'linux-arm64': 'aarch64-unknown-linux-gnu',
		'linux-x64': 'x86_64-unknown-linux-gnu',
		'win32-arm64': 'aarch64-pc-windows-msvc',
		'win32-x64': 'x86_64-pc-windows-msvc',
	};
	const target = targets[`${platform}-${architecture}`];
	if (!target) throw new Error(`Unsupported Ash development host: ${platform}/${architecture}`);
	return target;
}

function isPackageManifest(value: unknown, sequence: number): value is { readonly formatVersion: 1; readonly sequence: number; readonly directory: string } {
	return typeof value === 'object'
		&& value !== null
		&& 'formatVersion' in value
		&& value.formatVersion === 1
		&& 'sequence' in value
		&& value.sequence === sequence
		&& 'directory' in value
		&& typeof value.directory === 'string'
		&& /^packages\/[0-9A-Za-z][0-9A-Za-z.+-]*\/[a-f0-9]{64}$/u.test(value.directory);
}
