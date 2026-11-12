export const ACADEMY_PACKAGE_ID = 'ash.academy@ash';

/** Older catalog entries also belong to the Agent Window, regardless of their declared targets. */
export function isAcademyExtension(id: string): boolean {
	const normalized = id.toLowerCase();
	return normalized === ACADEMY_PACKAGE_ID || normalized === 'ash.academy' || normalized === 'ash/academy';
}
