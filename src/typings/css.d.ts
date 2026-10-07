// Recognize CSS files as valid side-effect imports.
declare module "*.css" {}

// Vite turns URL-query imports into emitted assets for the renderer bundle.
declare module "*?url" {
	const url: string;
	export default url;
}
