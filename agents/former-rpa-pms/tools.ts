// former-rpa-pms tools — the clean 4-stage funnel: search → pre-qualify → enrich → qualify. The
// generic judgment engine lives in src/decide.ts; this file is the agent-specific wiring. The one
// novel stage is pre-qualify: the deterministic vendor gate (vendors.ts) on the cheap experience
// pull, which kills non-fits before the slow feeds and the LLM ever run.

import {
	searchProfiles as lkSearchProfiles,
	getExperience,
	getProfileRest,
	publicIdOf
} from "../../src/clients/lk/index.js";
import { getStore } from "../../src/stores/index.js";
import { createDecider } from "../../src/decide.js";
import { renderEvidence } from "../../src/linkedin/evidence.js";
import { projectInput } from "../../src/linkedin/project.js";
import { classify } from "./vendors.js";
import { stringify } from "yaml";
import config from "./config.js";
import type { People } from "./schema/People.js";
import type { Leads } from "./schema/Leads.js";
import type { Sourcing } from "./schema/Sourcing.js";

const store = getStore(config.destination);
const decider = createDecider({ config, store, renderEvidence, projectInput });

const url = (publicId: string) => `https://www.linkedin.com/in/${publicId}`;

// Lead statuses AFTER pre-qualify — enrich or later has already acted. pre-qualify no-ops on these
// so a re-run never drags a moved lead backwards; it owns only To pre-qualify / To enrich / Not qualified.
const DOWNSTREAM = new Set([
	"To qualify",
	"Qualification pending approval",
	"To engage",
	"Engagement pending approval",
	"Engaged - waiting for lead",
	"Meeting booked"
]);

export const tools = {
	// search — discover profiles via one Google run. Per hit: a Person stub (idempotent on the
	// canonical LinkedIn URL) and, for a NEW person, a Lead at the funnel start ("To pre-qualify").
	// Then ONE Sourcing row for the run, linking the People it yielded.
	search: async (query: string, n?: number) => {
		const { script, args, hits } = await lkSearchProfiles(query, n);
		const ranAt = new Date().toISOString();
		const out = [];
		const personIds: string[] = [];
		for (const hit of hits) {
			const person: People = {
				Name: hit.name,
				Headline: hit.headline,
				"LinkedIn URL": hit.profileUrl,
				Updated: ranAt
			};
			const p = await store.upsert(config.models.People, person, "LinkedIn URL");
			personIds.push(p.id);
			if (p.created) {
				const lead: Leads = { Name: hit.name, Person: [p.id], Status: "To pre-qualify" };
				await store.upsert(config.models.Leads, lead, "Person");
			}
			out.push({ publicId: hit.publicId, name: hit.name, person: p.url, created: p.created });
		}
		const terms = query.replace(/\bsite:\S+\s*/g, "").trim();
		const sourcing: Sourcing = {
			Name: `Google Search ${terms} — ${ranAt.slice(0, 19).replace("T", " ")}`,
			Script: script,
			Args: JSON.stringify(args),
			"Ran at": ranAt,
			People: personIds
		};
		await store.upsert(config.models.Sourcing, sourcing, "Name");
		return out;
	},

	// pre-qualify — the deterministic gate. ONE cheap run (experience only), stored on the Person,
	// then `classify`: was a senior PM at an RPA vendor and has left? PASS ⇒ Lead "To enrich"
	// (advance to the full fetch); FAIL ⇒ Lead "Not qualified" (funnel stops — the slow feeds and
	// the LLM never run). Name is taken from the Person the search wrote (fallback: the publicId).
	preQualify: async (profile: string) => {
		const publicId = publicIdOf(profile);
		// No-op if this lead has already advanced past pre-qualify — never refetch or reset a lead that
		// enrich/qualify has moved on. Re-running on To pre-qualify / To enrich / Not qualified is fine.
		const existing = await store.read(config.models.People, "LinkedIn URL", url(publicId)).catch(() => null);
		if (existing) {
			const lead = await store.read(config.models.Leads, "Person", existing.id).catch(() => null);
			const status = lead ? String(lead.fields.Status ?? "") : "";
			if (DOWNSTREAM.has(status))
				return { publicId, name: String(existing.fields.Name ?? publicId), skipped: true, status };
		}
		const experience = await getExperience(profile);
		const pq = classify(experience);
		const name = existing?.fields.Name ? String(existing.fields.Name) : publicId;

		const person: People = {
			Name: name,
			"LinkedIn URL": url(publicId),
			Updated: new Date().toISOString(),
			Experiences: experience.positions.length
				? stringify(experience.positions, { lineWidth: 0 })
				: undefined
		};
		const p = await store.upsert(config.models.People, person, "LinkedIn URL");
		const lead: Leads = { Name: name, Person: [p.id], Status: pq.pass ? "To enrich" : "Not qualified" };
		const l = await store.upsert(config.models.Leads, lead, "Person");
		return { publicId, name, ...pq, person: p.url, lead: l.url };
	},

	// enrich — only for pre-qualify survivors. Fetches the REST of the profile (card + activity),
	// NOT experience (pre-qualify already wrote it — one experience pull per funnel). Fills the
	// Person (Headline/About/Location/Activity, Experiences left intact) and moves the Lead to
	// "To qualify". Idempotent.
	enrich: async (profile: string) => {
		const { publicId, card, posts, comments } = await getProfileRest(profile);
		const name = card.name ?? publicId;
		const person: People = {
			Name: name,
			Headline: card.headline ?? undefined,
			About: card.about ?? undefined,
			Location: card.location ?? undefined,
			"LinkedIn URL": url(publicId),
			Updated: new Date().toISOString(),
			Activity:
				posts.posts.length || comments.comments.length
					? stringify({ posts: posts.posts, comments: comments.comments }, { lineWidth: 0 })
					: undefined
		};
		const p = await store.upsert(config.models.People, person, "LinkedIn URL");
		const lead: Leads = { Name: name, Person: [p.id], Status: "To qualify" };
		const l = await store.upsert(config.models.Leads, lead, "Person");
		return { person: p.url, lead: l.url, publicId, name, posts: posts.posts.length, comments: comments.comments.length };
	},

	// qualify — the LLM judge against the soft-ICP contract; Lead moves to the human gate.
	qualify: (profile: string) => decider.decide("qualify", publicIdOf(profile)),

	// context — the read half of the judgment (contract + frozen evidence), for a manual judge.
	context: (profile: string) => decider.context("qualify", publicIdOf(profile)),

	// list — the decisions awaiting a human verdict (the review queue).
	list: () => decider.list(),

	// show — one Decision by the shared id: the judge's judgment plus, once ruled, the review diff.
	show: (handle: string) => decider.showDecision(handle)
};
