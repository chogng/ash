import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { extractLockedMember, materialize } from '../download/artifacts.ts';
import lock from '../../third_party/livekit/runtime-lock.json' with { type: 'json' };

const cache = resolve(import.meta.dirname, '../../third_party/.cache/livekit', lock.version);

/** Prepares the independent server without keeping its Go source in the repository. */
export async function resolveLivekit(target: string): Promise<{ executable: string }> {
	const artifactTarget = target.replace(/-musl$/, '-gnu');
	const artifact = Object.hasOwn(lock.artifacts, artifactTarget)
		? lock.artifacts[artifactTarget as keyof typeof lock.artifacts] : undefined;
	const mac = target === 'aarch64-apple-darwin' || target === 'x86_64-apple-darwin';
	if (!artifact && !mac) { throw new Error(`No media server build is defined for ${target}`); }
	if (mac && process.platform !== 'darwin') { throw new Error('The macOS media server must be built on macOS.'); }
	await mkdir(cache, { recursive: true });
	const name = target.includes('windows') ? 'livekit-server.exe' : 'livekit-server';
	const executable = join(cache, target, name);
	if (artifact) {
		const archive = await materialize(artifact, join(cache, artifact.archive), 128 * 1024 * 1024);
		await extractLockedMember(archive, artifact.sha256, name, executable, 256 * 1024 * 1024);
		await chmod(executable, 0o755);
		return { executable };
	}
	const directory = await mkdtemp(join(cache, `${target}-`));
	try {
		const output = join(directory, name);
		const archive = await materialize(lock.source, join(cache, 'source.tar.gz'), 10 * 1024 * 1024);
		run('tar', ['-xzf', archive, '-C', directory]);
		run('go', ['build', '-trimpath', '-buildvcs=false', '-mod=readonly', '-o', output, './cmd/server'], {
			cwd: join(directory, `livekit-${lock.version}`),
			env: { ...process.env, GOTOOLCHAIN: 'local', GOWORK: 'off', GOFLAGS: '', CGO_ENABLED: '1', GOOS: 'darwin', GOARCH: target.startsWith('aarch64') ? 'arm64' : 'amd64' },
		});
		await chmod(output, 0o755);
		await mkdir(join(cache, target), { recursive: true });
		await rename(output, executable);
		return { executable };
	} finally { await rm(directory, { recursive: true, force: true }); }
}

function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): void {
	const result = spawnSync(command, args, { ...options, stdio: 'inherit', windowsHide: true });
	if (result.error) { throw result.error; }
	if (result.status !== 0) { throw new Error(`${command} failed while building LiveKit ${lock.version}`); }
}

if (import.meta.main) {
	const target = process.argv[2];
	if (!target) { throw new Error('A Rust target triple is required.'); }
	console.log(JSON.stringify(await resolveLivekit(target)));
}
