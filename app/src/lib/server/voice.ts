// The Writer's grounding — the half of /api/complete that is not the caret. The Decision path grounds
// in a Prompt body + frozen Evidence fetched from Notion (memoized per id, because it is frozen); the
// Writer has no Decision, so it grounds in what is declared HERE: my voice (../writer/voice.md) and the
// samples ../writer/examples.yaml selects from ../writer/corpus/.
//
// All LOCAL, and all resolved at BUILD time — `?raw` imports and one eager `import.meta.glob`, never
// `fs` at runtime. Two reasons, and they are the whole design: on Vercel the completion runs in a
// serverless function whose filesystem does not contain this repo's loose files (a runtime read would
// work in dev and 500 in production), and a keystroke must not pay a disk read. So the corpus is
// bundled text, and the grounding a completion sees is fixed the moment the app is built.
//
// The order matters and it is deliberate: voice, then samples, then the per-document title. Everything
// before the title is identical on every request of every document, so it is one long stable prefix —
// exactly what Gemini's implicit cache keys on (watch the `cached=` term in complete.ts's log line).
// The caret moves at the END of the prompt, where it costs the least.

import { parse } from "yaml";
import voiceMd from "$lib/writer/voice.md?raw";
import manifestYaml from "$lib/writer/examples.yaml?raw";

// Every file in the corpus, bundled as text. Globbed rather than imported one by one so adding a
// sample is a file plus a line in examples.yaml — no import to remember here. The glob is the
// AVAILABLE set; examples.yaml is the CHOSEN set, and only chosen files reach a prompt.
const corpus = import.meta.glob("../writer/corpus/*.md", {
	query: "?raw",
	import: "default",
	eager: true
}) as Record<string, string>;

const byName = new Map(Object.entries(corpus).map(([path, text]) => [path.split("/").pop()!, text]));

// One entry of examples.yaml: which sample, and what register it is written in.
interface Pick {
	file: string;
	note?: string;
}

// The manifest, read once. An empty or comment-only file parses to null — that is a corpus of none,
// not an error (the voice alone is a valid grounding).
const picks = ((parse(manifestYaml) as Pick[] | null) ?? []).filter((p) => p?.file);

// Fail loud, at module load: a `file:` naming something the corpus does not have is a config typo, and
// silently dropping it would mean writing all day in a voice grounded on two samples while the manifest
// claims three. The message names both sides, because "which filename did I get wrong" is the question.
const missing = picks.filter((p) => !byName.has(p.file));
if (missing.length)
	throw new Error(
		`writer examples.yaml names ${missing.length} file(s) not in lib/writer/corpus/: ` +
			`${missing.map((p) => p.file).join(", ")} — have: ${[...byName.keys()].join(", ") || "(none)"}`
	);

// The samples block: my own published pieces, each labeled with its register (the manifest's `note`),
// so the model can tell a launch post from a reply to someone else's thread. Same `<examples>` shape
// the judge's few-shot uses ($core/decide.ts examplesFor) — one idiom for "here is prior work".
const samples = picks.length
	? `## How I write — samples of my own published writing\n\n<examples>\n${picks
			.map((p) => {
				const label = p.note ? `<!-- ${p.note} -->\n` : "";
				return `<example>\n${label}${byName.get(p.file)!.trim()}\n</example>`;
			})
			.join("\n")}\n</examples>`
	: "";

const voice = voiceMd.trim();

// writerGround(title) — the Writer's grounding blocks, in prefix-stable order. The title is the only
// per-request part, so it comes last; the endpoint appends the Task and the Draft after it.
export const writerGround = (title?: string): string[] => [
	voice,
	samples,
	`## This draft\n\nI am drafting a piece${title ? ` titled "${title}"` : " with no title yet"}.`
];
