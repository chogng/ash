import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { developmentAshPackagePath } from './runtimeStore.ts';
import { buildAppServerEnvironment } from '../../app-ts/src/ash/platform/app-server/common/appServerEnvironment.ts';
import { decodeWebListenInfo } from '../../app-ts/src/ash/platform/app-server/common/generated/WebProtocolDecoder.ts';
import type { WebListenInfo } from '../../app-ts/src/ash/platform/app-server/common/generated/WebListenInfo.ts';

interface WebLaunch {
	readonly info: WebListenInfo;
	readonly exited: Promise<number>;
	close(): Promise<void>;
}

export async function startWeb(options: { port: number; assets?: string; origin?: string }): Promise<WebLaunch> {
	const root = resolve(import.meta.dirname, '../..');
	const packageRoot = developmentAshPackagePath(root, 'packaged-node');
	const suffix = process.platform === 'win32' ? '.exe' : '';
	const executable = process.env.ASH_APP_SERVER_PATH ?? join(packageRoot, 'bin', `ash-app-server${suffix}`);
	const environment = buildAppServerEnvironment(process.env, process.platform === 'win32' ? 'windows' : 'posix', {
		ASH_HOME: resolve(process.env.ASH_WEB_APP_SERVER_PROFILE ?? join(root, '.build/app-ts/dev/web-profile')),
		ASH_WORKSPACE_ROOT: resolve(process.env.ASH_WORKSPACE_ROOT ?? root),
		ASH_RG_PATH: resolve(process.env.ASH_RG_PATH ?? join(packageRoot, 'ash-path', `rg${suffix}`)),
		...(process.env.ASH_PRODUCT_SERVICES_PATH ? { ASH_PRODUCT_SERVICES_PATH: process.env.ASH_PRODUCT_SERVICES_PATH } : {}),
	});
	const arguments_ = ['--web', '--port', String(options.port)];
	if (options.assets) { arguments_.push('--assets', options.assets); }
	if (options.origin) { arguments_.push('--origin', options.origin); }
	const child = spawn(executable, arguments_, { cwd: root, env: environment, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
	let diagnostic = '';
	child.stderr.on('data', chunk => { diagnostic = (diagnostic + String(chunk)).slice(-8192); });
	const exited = new Promise<number>(resolveExit => { child.once('close', code => resolveExit(code ?? 1)); });
	let closing: Promise<void> | undefined;
	const close = (): Promise<void> => closing ??= (async () => {
		child.stdin.end();
		const timeout = setTimeout(() => child.kill(), 5_000);
		try { await exited; } finally { clearTimeout(timeout); }
	})();
	try {
		const info = await new Promise<WebListenInfo>((resolveInfo, reject) => {
			const lines = createInterface({ input: child.stdout });
			const timeout = setTimeout(() => finish(new Error('Web listener did not become ready')), 30_000);
			const onError = (error: Error): void => finish(error);
			const onClose = (): void => finish(new Error(`Web launch failed: ${diagnostic}`));
			const finish = (error?: Error, value?: WebListenInfo): void => {
				clearTimeout(timeout); lines.close(); child.stdout.resume(); child.off('error', onError); child.off('close', onClose);
				if (error) { reject(error); } else { resolveInfo(value!); }
			};
			child.once('error', onError); child.once('close', onClose);
			lines.once('line', line => {
				try {
					if (line.length > 16_384) { throw new Error('Invalid Web launch record'); }
					finish(undefined, decodeWebListenInfo(JSON.parse(line)));
				} catch (error) { finish(error instanceof Error ? error : new Error('Invalid Web launch record')); }
			});
		});
		return { info, exited, close };
	} catch (error) { await close(); throw error; }
}

export function authenticatedWebUrl(info: WebListenInfo, origin = info.endpoint): string {
	const url = new URL('/browser/workbench/workbench.html', origin);
	url.hash = new URLSearchParams({ 'ash-endpoint': info.endpoint, 'ash-ticket': info.ticket }).toString();
	return url.href;
}
