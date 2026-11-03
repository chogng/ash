export function spaceMarkCenters(positions: readonly number[], height: number, gap: number): number[] {
	let previous = -gap / 2;
	return positions.map((position, index) => {
		const limit = height - gap / 2 - (positions.length - index - 1) * gap;
		previous = Math.min(limit, Math.max(previous + gap, position * height));
		return previous;
	});
}
