/** Resolves shutdown vetoes together; rejected checks also prevent shutdown. */
export async function handleVetos(vetos: readonly (boolean | Promise<boolean>)[], onError: (error: Error) => void): Promise<boolean> {
	const results = await Promise.allSettled(vetos.map(veto => Promise.resolve(veto)));
	let isVetoed = false;
	for (const result of results) {
		if (result.status === 'rejected') {
			isVetoed = true;
			onError(result.reason instanceof Error ? result.reason : new Error('Shutdown veto failed', { cause: result.reason }));
		} else if (result.value) {
			isVetoed = true;
		}
	}
	return isVetoed;
}
