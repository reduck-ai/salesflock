// The prompt contracts, as the app reads them. A prompt is a folder in the repo
// (agents/<id>/prompts/<key>/), and the app needs two things out of it: the Output schema that
// governs what a human may commit, and the instructions that ground the autocomplete — the same two
// the judge used, which is the point of them being one file rather than a row someone might edit
// between the judgment and the review.
//
// BUILD TIME, like the Writer's voice and corpus next door (server/voice.ts), and for the same reason
// spelled out there: on Vercel this runs in a serverless function whose filesystem does not contain
// the repo's loose files, so `fs` would work in dev and 500 in production. Hence a glob rather than
// $core/prompts' loader — the parsing is trivial (that is what dropping frontmatter bought), and what
// must not be duplicated is `compileAuthoring`, which is $core's and shared.
//
// This replaced three network reads per card (the Prompt page, its Output schema, its body) and the
// two caches that made them bearable.

import { compileAuthoring } from "$core/stores/notion.codec";
import { agentFor } from "$agents/index";

// The prompt tree, bundled as text: agents/<id>/prompts/<key>/<file>.
const files = import.meta.glob("../../../../agents/*/prompts/*/{PROMPT.md,output.json}", {
	query: "?raw",
	import: "default",
	eager: true
}) as Record<string, string>;

// Fail loud, at module load, exactly as the Writer's corpus does for a missing sample: a glob that
// matches nothing is not an error to Vite, so without this the app would build clean and then render
// every card with no Output schema and an ungrounded composer — a silent, whole-surface degradation
// with no failing anything. If this throws, the pattern and the tree have parted ways.
if (!Object.keys(files).length)
	throw new Error(
		"no prompt files bundled — the glob agents/*/prompts/*/{PROMPT.md,output.json} matched nothing"
	);

export interface PromptFiles {
	system: string; // the instructions, markers dropped — what the judge read
	outputSchema?: Record<string, unknown>;
}

const byKey = new Map<string, PromptFiles>();
for (const [path, text] of Object.entries(files)) {
	const parts = path.split("/");
	const key = `${parts[parts.length - 4]}/${parts[parts.length - 2]}`; // <agent>/<promptKey>
	const entry = byKey.get(key) ?? { system: "" };
	if (path.endsWith("PROMPT.md")) entry.system = compileAuthoring(text).trim();
	else entry.outputSchema = JSON.parse(text) as Record<string, unknown>;
	byKey.set(key, entry);
}

// promptFor(kind) — the contract behind a Decision, resolved through the roster: the row says which
// KIND judged it, the roster says which agent declares that kind and under which key, and the key is
// the folder. Undefined for a kind no agent declares today (a renamed prompt, a decommissioned
// agent) — the caller keeps such rows readable and never moves their pipeline.
export const promptFor = (kind?: string): PromptFiles | undefined => {
	const owner = agentFor(kind);
	return owner && byKey.get(`${owner.id}/${owner.key}`);
};
