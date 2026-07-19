import tailwindcss from "@tailwindcss/vite";
import adapter from "@sveltejs/adapter-vercel";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
	// Shared files under ../src and ../agents `import "yaml"`, but on Vercel only
	// app/node_modules is installed — resolving from the importing file's dir (outside the
	// app root) misses it. dedupe forces yaml to resolve from the app root, via normal
	// package resolution (so dev's CJS→ESM interop still works, unlike a hard path alias).
	resolve: { dedupe: ["yaml"] },
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) => (filename.split(/[/\\]/).includes("node_modules") ? undefined : true)
			},
			adapter: adapter(),
			// The parent repo's core — shared primitives the app must not re-implement
			// (first user: the Notion codec) — and the agent's config, the one map of
			// decision kind → pipeline semantics (its store imports are type-only, so the
			// app pulls in pure data). See APP.md → Deploy for the Vercel toggle.
			alias: { $core: "../src", $agent: "../agents/linkedin-leads" }
		})
	]
});
