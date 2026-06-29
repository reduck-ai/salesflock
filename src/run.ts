// Runner — the one bit of plumbing. Shells the reduck CLI and returns its JSON
// result, reusing the user's device, auth and cookies. No transport of our own.
// Set REDUCK_BIN to override the binary (e.g. an absolute dev path).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Script } from "./scripts.js";

const exec = promisify(execFile);
const BIN = process.env.REDUCK_BIN ?? "reduck";

export type Args = Record<string, string | number>;
export type Runner = (script: Script, args: Args) => Promise<unknown>;

export const run: Runner = async (script, args) => {
	const addr = `${script.handle}/${script.host}/${script.slug}`;
	const pairs = Object.entries(args).map(([k, v]) => `${k}=${v}`);
	// `reduck run` prints the result as JSON on stdout (run id + errors on stderr).
	const { stdout } = await exec(BIN, ["run", "--script", addr, ...pairs]);
	return JSON.parse(stdout);
};
