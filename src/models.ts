// WHICH TABLES THIS INSTALLATION WRITES TO — the one thing about an agent that is not the same for
// everyone who runs it. A table id is a page in one workspace, so it is configuration in exactly the
// sense a secret is: the same code, pointed somewhere else. It used to be typed into `config.ts`
// beside the pipeline semantics, which is what made a clone unrunnable — a fork had to edit source
// to say where its own Notion is.
//
// So `config.ts` now declares only the model NAMES its code addresses, and the ids live in one
// place: `models.local.json` (written by `sflock init`, git-ignored) or the `SALESFLOCK_MODELS`
// variable it is loaded into. One place, not a default here and an override there — a merge would
// mean a typo'd local id silently falls back to the author's own workspace, which is the one failure
// worth designing out.
//
// ENV, NEVER A FILE READ HERE, and that is deliberate: `config.ts` is imported by the review app's
// bundle as well as by the CLI, and a `node:fs` read at module load would be a build-time hazard for
// the sake of a value the app gets from its environment anyway. The file half lives in `src/env.ts`,
// which every binary already imports first — the same place `.env` enters the process.

export const MODELS_ENV = "SALESFLOCK_MODELS";

// The whole map: `{ "<agent>": { "<Model>": "<table id>" } }`. A malformed value is loud rather than
// quietly empty — "no ids at all" and "ids I could not read" need different fixes.
let parsed: Record<string, Record<string, string>> | undefined;
const local = (): Record<string, Record<string, string>> => {
	const raw = process.env[MODELS_ENV];
	if (!raw?.trim()) return {};
	if (parsed) return parsed;
	try {
		return (parsed = JSON.parse(raw) as Record<string, Record<string, string>>);
	} catch (e) {
		throw new Error(`${MODELS_ENV} is not valid JSON: ${(e as Error).message}`);
	}
};

// models(agent, keys) — the agent's model map, resolved from this installation.
//
// Each key is a GETTER, and that is what makes an unconfigured installation say so in one sentence
// at the moment it matters. Reading an id is what needs the id; merely importing the agent is not —
// and `sflock init`, which exists precisely to create these tables, imports every agent's config to
// find them. A map that threw when it was built would make the fix unreachable from the tool that
// applies it. Enumeration still works (`sflock pull` walks `Object.entries(config.models)`), and
// reading an unset key from there fails the same way, which is right: pull describes live tables.
export const models = <K extends string>(agent: string, keys: readonly K[]): Record<K, string> => {
	const out = {} as Record<K, string>;
	for (const key of keys)
		Object.defineProperty(out, key, {
			enumerable: true,
			get: () =>
				local()[agent]?.[key] ??
				(() => {
					throw new Error(
						`no table id for ${agent}.${key} — this installation has not been set up. Run ` +
							`\`sflock init --parent <notion page url>\` to create the tables (it writes ` +
							`models.local.json), or set ${MODELS_ENV} to the map you already have.`
					);
				})()
		});
	return out;
};
