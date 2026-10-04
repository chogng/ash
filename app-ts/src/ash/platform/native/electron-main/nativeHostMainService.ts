/** Reads the desktop process's effective privilege, independently of its App Server. */
export async function isAdmin(): Promise<boolean> {
	if (process.platform === 'win32') {
		const { default: isElevated } = await import('native-is-elevated');
		return isElevated();
	}
	return process.geteuid!() === 0;
}
