import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { localize } from '../../../nls.js';
import type { RemoteAgentHostConnection } from '../common/remoteAgentHostService.js';

const run = promisify(execFile);
const DISTRO_LIST_MAX_AGE_MS = 30_000;

interface IWSLProcessHost {
	list(args: readonly string[]): Promise<Buffer>;
	launch(args: readonly string[]): ChildProcessWithoutNullStreams;
}

/** Acquires a WSL process; the window's existing connection pool owns its lease. */
export class WSLRemoteAgentHostService {
	private distros: Promise<readonly string[]> | undefined;
	private distrosExpireAt = 0;

	constructor(
		private readonly platform = process.platform,
		private readonly processes: IWSLProcessHost = {
			list: async args => (await run('wsl.exe', args, { encoding: 'buffer', timeout: 15_000, maxBuffer: 1024 * 1024, windowsHide: true })).stdout,
			launch: args => spawn('wsl.exe', args, { stdio: 'pipe', windowsHide: true, shell: false }),
		},
	) { }

	public async listDistros(): Promise<readonly string[]> {
		if (this.distros && Date.now() < this.distrosExpireAt) return this.distros;
		this.distrosExpireAt = Infinity;
		const distros = this.distros = this.enumerateDistros();
		void distros.then(() => {
			this.distrosExpireAt = Date.now() + DISTRO_LIST_MAX_AGE_MS;
		}, () => {
			this.distros = undefined;
		});
		return distros;
	}

	private async enumerateDistros(): Promise<readonly string[]> {
		if (this.platform !== 'win32') return [];
		const execute = async (flag: string): Promise<string> => {
			const stdout = await this.processes.list(['--list', flag]);
			return (stdout.includes(0) ? stdout.toString('utf16le') : stdout.toString('utf8')).replace(/^\uFEFF/, '');
		};
		const names = (await execute('--quiet')).split(/\r?\n/).map(name => name.trim()).filter(Boolean);
		const versions = (await execute('--verbose')).split(/\r?\n/);
		// Match known names first: localized status labels can contain spaces too.
		const longestFirst = [...names].sort((a, b) => b.length - a.length);
		const supported = new Set<string>();
		for (const line of versions) {
			const entry = line.replace(/^\s*\*?\s*/, '');
			const name = longestFirst.find(name => entry.startsWith(name) && /^\s+/.test(entry.slice(name.length)));
			if (name && /\s+2\s*$/.test(entry)) supported.add(name);
		}
		return names.filter(name => supported.has(name));
	}

	public createProcessLauncher(target: Extract<RemoteAgentHostConnection, { type: 'wsl'; }>) {
		return {
			description: `WSL ${target.distro}`,
			validate: async () => {
				if (!(await this.enumerateDistros()).includes(target.distro)) throw new Error(localize('agentHost.wslUnavailable', 'The selected WSL 2 distribution is unavailable.'));
			},
			// No shell or user-supplied executable: the independently installed Remote runtime owns the daemon.
			launch: (): ChildProcessWithoutNullStreams => this.processes.launch([
				'--distribution', target.distro, '--exec', 'env', `ASH_WORKSPACE_ROOT=${target.workspace}`, 'ash-remote-server', 'connect',
			]),
		};
	}
}
