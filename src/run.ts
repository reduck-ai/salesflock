// Runner — the one bit of plumbing. Shells the bundled reduck CLI and returns its
// JSON result, reusing the user's device, auth and cookies. Self-contained: the CLI
// is a dependency, resolved from node_modules (no global install). REDUCK_BIN
// overrides — e.g. a patched local build. The script's contract (args, output)
// lives in the script — `reduck read reduck/<host>/<slug>` — never restated here.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const exec = promisify(execFile);
const require = createRequire(import.meta.url);

// The bundled CLI's entry, run under this same node. Falls back to a `reduck` on
// PATH if the dependency can't be resolved.
function reduckArgv(): string[] {
	if (process.env.REDUCK_BIN) return [process.env.REDUCK_BIN];
	try {
		const pkg = require.resolve("@reduck-ai/cli/package.json");
		const { bin } = require(pkg) as { bin: string | Record<string, string> };
		return [process.execPath, join(dirname(pkg), typeof bin === "string" ? bin : bin.reduck)];
	} catch {
		return ["reduck"];
	}
}

export type Args = Record<string, string | number | boolean>;

export const run = async (addr: string, args: Args): Promise<unknown> => {
	const pairs = Object.entries(args).map(([k, v]) => `${k}=${v}`);
	const [cmd, ...pre] = reduckArgv();
	// `reduck run` prints the result as JSON on stdout (run id + errors on stderr).
	const { stdout } = await exec(cmd, [...pre, "run", "--script", addr, ...pairs]);
	return JSON.parse(stdout);
};
