import { OperatingSystem, operatingSystem } from '../../../base/common/platform.js';
import { GeneralShellType, PosixShellType, type IShellLaunchConfig, type TerminalShellType } from './terminal.js';

/** Quotes a literal path without losing shell metacharacters that belong to the filename. */
export function escapeNonWindowsPath(path: string, shellType?: TerminalShellType): string {
	if (shellType === GeneralShellType.PowerShell) return "'" + path.replaceAll("'", "''") + "'";
	if (shellType === PosixShellType.Fish) return "'" + path.replaceAll('\\', '\\\\').replaceAll("'", "\\'") + "'";
	return "'" + path.replaceAll("'", "'\"'\"'") + "'";
}

/** Launch configuration may quote a cwd; execution-host semantics decide drive-letter casing. */
export function sanitizeCwd(cwd: string, os = operatingSystem): string {
	if (cwd.length >= 2 && (cwd[0] === '"' || cwd[0] === "'") && cwd.at(-1) === cwd[0]) cwd = cwd.slice(1, -1);
	return os === OperatingSystem.Windows && /^[a-z]:/.test(cwd) ? cwd[0]!.toUpperCase() + cwd.slice(1) : cwd;
}

/** Literal launch environments bypass extension-owned mutations. */
export function shouldUseEnvironmentVariableCollection(slc: IShellLaunchConfig): boolean {
	return !slc.strictEnv;
}
