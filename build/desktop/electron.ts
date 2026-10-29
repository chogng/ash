import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	constants,
	copyFileSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { AshApplicationId, AshApplicationName } from '../../src/ash/code/common/application.ts';
import { desktopBuildPath } from './paths.ts';

/** Resolve an already prepared runtime without copying, signing, or publishing files. */
export function resolveDevelopmentElectronExecutable(repositoryRoot: string): string {
	const runtime = developmentRuntime(repositoryRoot);
	if (runtime.bundle && (!existsSync(join(runtime.bundle.output, 'ready')) || !existsSync(runtime.executable))) {
		throw new Error('Development Electron runtime is missing or stale. Run pnpm prepare:electron.');
	}
	return runtime.executable;
}

/** Prepare a private runtime while retaining Electron's source-directory launch behavior. */
export function prepareDevelopmentElectron(repositoryRoot: string): string {
	const runtime = developmentRuntime(repositoryRoot);
	if (!runtime.bundle) return runtime.executable;
	const { source, icon, stamp, output } = runtime.bundle;
	if (existsSync(join(output, 'ready')) && existsSync(runtime.executable)) return runtime.executable;
	mkdirSync(dirname(output), { recursive: true });
	const staging = mkdtempSync(`${output}-`);
	try {
		const bundle = join(staging, `${AshApplicationName}.app`);
		// Clone where supported; never modify or hard-link the shared pnpm dependency.
		cpSync(source, bundle, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
		// Electron infers app.isPackaged from the executable basename. Keep the
		// development executable while branding the bundle shown by macOS.
		brandBundle(bundle, 'Electron', AshApplicationName, `${AshApplicationId}.development`, icon, 'Electron');
		for (const directory of ['Contents/Frameworks', 'Contents/Library/LoginItems']) {
			const helpers = join(bundle, directory);
			if (!existsSync(helpers)) continue;
			for (const entry of readdirSync(helpers)) {
				if (!/^Electron (?:Helper|Login Helper).*\.app$/u.test(entry)) continue;
				const original = basename(entry, '.app');
				const name = original.replace(/^Electron/u, AshApplicationName);
				const suffix = original
					.slice('Electron '.length)
					.replace(/[^a-zA-Z0-9]+/gu, '')
					.toLowerCase();
				brandBundle(join(helpers, entry), original, name, `${AshApplicationId}.development.${suffix}`, icon);
				renameSync(join(helpers, entry), join(helpers, `${name}.app`));
			}
		}
		// Changed bundle metadata invalidates upstream signatures. Preserve execution entitlements.
		execFileSync(
			'/usr/bin/codesign',
			['--force', '--deep', '--sign', '-', '--preserve-metadata=entitlements,flags,runtime', bundle],
			{ stdio: 'pipe' },
		);
		writeFileSync(join(staging, 'ready'), `${stamp}\n`);
		try {
			renameSync(staging, output);
		} catch (error) {
			// Concurrent preparations may publish the same immutable runtime first.
			if (!existsSync(join(output, 'ready')) || !existsSync(runtime.executable)) throw error;
		}
		return runtime.executable;
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}

function developmentRuntime(repositoryRoot: string): {
	readonly executable: string;
	readonly bundle?: {
		readonly source: string;
		readonly icon: string;
		readonly stamp: string;
		readonly output: string;
	};
} {
	const executable: string = createRequire(resolve(repositoryRoot, 'package.json'))('electron');
	// Custom test executables and other platforms retain their existing launcher.
	if (process.platform !== 'darwin' || basename(executable) !== 'Electron') return { executable };
	const source = realpathSync(resolve(dirname(executable), '../..'));
	const icon = join(repositoryRoot, 'resources/darwin/ash.icns');
	const stamp = createHash('sha256')
		.update(JSON.stringify([source, statSync(executable).mtimeMs, AshApplicationName, AshApplicationId]))
		.update(readFileSync(join(source, 'Contents/Info.plist')))
		.update(readFileSync(icon))
		.update(readFileSync(join(repositoryRoot, 'build/desktop/electron.ts')))
		.digest('hex')
		.slice(0, 16);
	const output = desktopBuildPath(repositoryRoot, 'electron', stamp);
	return {
		executable: join(output, `${AshApplicationName}.app`, 'Contents/MacOS', 'Electron'),
		bundle: { source, icon, stamp, output },
	};
}

function brandBundle(
	bundle: string,
	original: string,
	name: string,
	identifier: string,
	icon: string,
	executable = name,
): void {
	const contents = join(bundle, 'Contents');
	const plist = join(contents, 'Info.plist');
	const metadata = JSON.parse(
		execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8' }),
	);
	Object.assign(metadata, {
		CFBundleName: name,
		CFBundleDisplayName: name,
		CFBundleExecutable: executable,
		CFBundleIdentifier: identifier,
		CFBundleIconFile: 'ash.icns',
	});
	writeFileSync(plist, JSON.stringify(metadata));
	execFileSync('/usr/bin/plutil', ['-convert', 'xml1', plist]);
	mkdirSync(join(contents, 'Resources'), { recursive: true });
	copyFileSync(icon, join(contents, 'Resources/ash.icns'));
	if (original !== executable) renameSync(join(contents, 'MacOS', original), join(contents, 'MacOS', executable));
}
