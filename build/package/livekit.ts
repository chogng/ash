import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { extractMember, materialize } from '../download/artifacts.ts';

const version = '1.13.7';
const cache = resolve(import.meta.dirname, '../../third_party/.cache/livekit', version);
const archives: Readonly<Record<string, { name: string; sha256: string }>> = {
	'x86_64-unknown-linux-gnu': { name: 'linux_amd64', sha256: '6634aeeb2fb1366b6723708ae4320b9d5408106a4c63457c5e845ae3979c90e2' },
	'aarch64-unknown-linux-gnu': { name: 'linux_arm64', sha256: '5d167fdf52cf43c0c72972f25325364479f41f854bfef651056eab2504da5de9' },
	'aarch64-pc-windows-msvc': { name: 'windows_arm64', sha256: '8379c89b9973dc52577710b293f6190644bd6fad0c415df4279a24ea54df2363' },
	'x86_64-pc-windows-msvc': { name: 'windows_amd64', sha256: 'e539e7d2f75807b9c9202cd2a0bf2cb3d52fc4c52978a6953e0f47bc339fe77f' },
};

/** Resolves the fixed media server release; macOS uses its checksum-verified source archive. */
export async function resolveLivekit(target: string): Promise<{ executable: string; license: string }> {
	await mkdir(cache, { recursive: true });
	const source = await materialize({
		url: `https://codeload.github.com/livekit/livekit/tar.gz/refs/tags/v${version}`,
		sha256: 'b42f34b095dff22639a40256c3f98fd563fdbce5d497e449ceb06ee010de88c5',
	}, join(cache, 'source.tar.gz'), 10 * 1024 * 1024);
	const license = join(cache, 'LICENSE');
	await extractMember(source, `livekit-${version}/LICENSE`, license, 64 * 1024);
	const directory = await mkdtemp(join(cache, `${target}-`));
	const executable = join(cache, target, target.includes('windows') ? 'livekit-server.exe' : 'livekit-server');
	try {
		// Published Linux executables use CGO_ENABLED=0 and run on both libc families.
		const archive = archives[target.replace(/-musl$/, '-gnu')];
		const output = join(directory, 'livekit-server');
		if (archive) {
			const name = `livekit_${version}_${archive.name}.${target.includes('windows') ? 'zip' : 'tar.gz'}`;
			const downloaded = await materialize({ url: `https://github.com/livekit/livekit/releases/download/v${version}/${name}`, sha256: archive.sha256 }, join(cache, name), 128 * 1024 * 1024);
			await extractMember(downloaded, target.includes('windows') ? 'livekit-server.exe' : 'livekit-server', output, 256 * 1024 * 1024);
		} else if (target === 'aarch64-apple-darwin' || target === 'x86_64-apple-darwin') {
			if (process.platform !== 'darwin') { throw new Error('The macOS media server must be built on macOS.'); }
			run('tar', ['-xzf', source, '-C', directory]);
			run('go', ['build', '-trimpath', '-mod=readonly', '-o', output, './cmd/server'], {
				cwd: join(directory, `livekit-${version}`),
				env: { ...process.env, GOTOOLCHAIN: 'local', CGO_ENABLED: '1', GOOS: 'darwin', GOARCH: target.startsWith('aarch64') ? 'arm64' : 'amd64' },
			});
		} else { throw new Error(`No media server build is defined for ${target}`); }
		await chmod(output, 0o755);
		await mkdir(join(cache, target), { recursive: true });
		await rename(output, executable);
		return { executable, license };
	} finally { await rm(directory, { recursive: true, force: true }); }
}

function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): void {
	const result = spawnSync(command, args, { ...options, stdio: 'inherit', windowsHide: true });
	if (result.error) { throw result.error; }
	if (result.status !== 0) { throw new Error(`${command} failed while building LiveKit ${version}`); }
}

if (import.meta.main) {
	const target = process.argv[2];
	if (!target) { throw new Error('A Rust target triple is required.'); }
	console.log(JSON.stringify(await resolveLivekit(target)));
}
