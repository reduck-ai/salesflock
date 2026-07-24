// former-rpa-pms tools — the clean 4-stage funnel: search → pre-qualify → enrich → qualify. The
// generic judgment engine lives in src/decide.ts; this file is the agent-specific wiring. The one
// novel stage is pre-qualify: the deterministic vendor gate (vendors.ts) on the cheap experience
// pull, which kills non-fits before the slow feeds and the LLM ever run.
//
// One identity key throughout: the canonical LinkedIn URL (`profileUrl`). Every Person and Lead is
// upserted on it, so a re-run converges instead of duplicating. The funnel is monotonic — an earlier
// stage never drags a lead backward: it no-ops (and reports `skipped`/`existing`) once the lead has
// advanced past its own target, "Not qualified" being the terminal miss.

import {
	searchProfiles as lkSearchProfiles,
	getExperience,
	getProfileRest,
	publicIdOf,
	profileUrl
} from "../../src/clients/lk/index.js";
import { getStore } from "../../src/stores/index.js";
import { createDecider } from "../../src/decide.js";
import { renderEvidence } from "./evidence.js";
import { projectInput } from "../../src/project.js";
import type { Subject } from "../../src/decide.js";
import type { PromptSpec } from "../../src/stores/index.js";
import { classify, disposition } from "./vendors.js";
import { stringify } from "yaml";
import config from "./config.js";
import type { People } from "./schema/People.js";
import type { Leads } from "./schema/Leads.js";
import type { Sourcing } from "./schema/Sourcing.js";

const store = getStore(config.destination);

// This agent's entity bridge (its own wiring, not the engine's): the subject is a Person, read by
// the canonical LinkedIn URL; the Decision binds to a Lead upserted on that same URL and advanced
// to the prompt's pending gate (unless the decision is a held DAG dependent).
const resolveSubject = async (publicId: string): Promise<Subject> => {
	const person = await store.read(config.models.People, "LinkedIn URL", profileUrl(publicId));
	return { key: publicId, name: String(person.fields.Name ?? publicId), fields: person.fields, ref: person.id };
};
const linkEntity = async (subject: Subject, spec: PromptSpec, { dependsOn }: { dependsOn?: string[] }): Promise<string> => {
	const lead = {
		Name: subject.name,
		...(subject.ref ? { Person: [subject.ref] } : {}),
		"LinkedIn URL": profileUrl(subject.key),
		...(dependsOn?.length ? {} : { Status: spec.pending })
	};
	const l = await store.upsert(config.models.Leads, lead, "LinkedIn URL");
	return l.id;
};

const decider = createDecider({ config, store, renderEvidence, projectInput, resolveSubject, linkEntity });

// The funnel's forward order. Each stage no-ops if the lead already sits at or past the stage's own
// target, so a re-run never drags it backward; "Not qualified" is the terminal miss, off the ladder.
const LADDER = [
	"To pre-qualify",
	"To enrich",
	"To qualify",
	"Qualification pending approval",
	"To engage",
	"Engagement pending approval",
	"Engaged - waiting for lead",
	"Meeting booked"
] as const;
const rank = (s: string | null): number => (s ? LADDER.indexOf(s as (typeof LADDER)[number]) : -1);

// The lead's current Status by its LinkedIn URL (the sole key), or null if no lead exists yet.
// `query` returns [] for not-found and throws on a real store error — no catch to swallow either.
const leadStatus = async (u: string): Promise<string | null> => {
	const [lead] = await store.query(config.models.Leads, { property: "LinkedIn URL", url: { equals: u } });
	return lead ? String(lead.fields.Status ?? "") : null;
};

export const tools = {
	// search — discover profiles via one Google run. Per hit: a Person (idempotent on the LinkedIn
	// URL) and, only if no Lead exists for that URL yet, a Lead at the funnel start ("To pre-qualify").
	// A hit already in the CRM is reported (`existing`, with its Status), never re-added. Then ONE
	// Sourcing row for the run, linking every Person it yielded.
	search: async (query: string, page?: number) => {
		const { script, args, hits } = await lkSearchProfiles(query, page);
		const ranAt = new Date().toISOString();
		const out = [];
		const personIds: string[] = [];
		for (const hit of hits) {
			const u = profileUrl(hit.publicId);
			const person: People = { Name: hit.name, Headline: hit.headline, "LinkedIn URL": u, Updated: ranAt };
			const p = await store.upsert(config.models.People, person, "LinkedIn URL");
			personIds.push(p.id);
			const status = await leadStatus(u);
			if (status === null) {
				const lead: Leads = { Name: hit.name, Person: [p.id], "LinkedIn URL": u, Status: "To pre-qualify" };
				await store.upsert(config.models.Leads, lead, "LinkedIn URL");
			}
			out.push({ publicId: hit.publicId, name: hit.name, person: p.url, existing: status !== null, ...(status !== null ? { status } : {}) });
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

	// pre-qualify — the deterministic gate. No-ops on a settled lead: already advanced past pre-qualify
	// (someone enriched it) or terminally "Not qualified". Otherwise ONE cheap run (experience only),
	// stored on the Person, then `classify`: was a senior PM at an RPA vendor and has left? PASS ⇒ Lead
	// "To enrich"; data-backed MISS ⇒ Lead "Not qualified" (funnel stops — slow feeds and LLM never run);
	// INSUFFICIENT DATA (empty/corrupt scrape) ⇒ left at "To pre-qualify" to retry, never eliminated.
	preQualify: async (profile: string) => {
		const publicId = publicIdOf(profile);
		const u = profileUrl(publicId);
		const status = await leadStatus(u);
		if (status === "Not qualified" || rank(status) >= rank("To qualify"))
			return { publicId, skipped: true, status };
		const [existing] = await store.query(config.models.People, { property: "LinkedIn URL", url: { equals: u } });
		const experience = await getExperience(profile);
		const pq = classify(experience);
		const name = existing?.fields.Name ? String(existing.fields.Name) : publicId;
		const person: People = {
			Name: name,
			"LinkedIn URL": u,
			Updated: new Date().toISOString(),
			Experiences: experience.positions.length
				? stringify(experience.positions, { lineWidth: 0 })
				: undefined
		};
		const p = await store.upsert(config.models.People, person, "LinkedIn URL");
		// Advance on a pass, eliminate on a data-backed miss, and — crucially — leave insufficient-data
		// leads AT "To pre-qualify" (no Status write) so a corrupt/empty scrape defers to a retry rather
		// than a false "Not qualified": we only eliminate people we have the data to eliminate.
		const advance = pq.pass ? "To enrich" : pq.eliminate ? "Not qualified" : null;
		const lead: Leads = { Name: name, Person: [p.id], "LinkedIn URL": u, ...(advance ? { Status: advance } : {}) };
		const l = await store.upsert(config.models.Leads, lead, "LinkedIn URL");
		// A rejection is terminal (the monotonic guard never re-runs pre-qualify on it), so this
		// records the reason exactly once — no duplicate comments on re-run. Insufficient-data is not
		// terminal, so it is never commented (a retry would duplicate it).
		if (pq.eliminate) await store.comment(l.id, disposition(pq));
		return { publicId, name, ...pq, person: p.url, lead: l.url };
	},

	// enrich — only for pre-qualify survivors. No-ops on a settled lead (Not qualified, or already at
	// the human gate / engaged). Fetches the REST of the profile (card + activity), NOT experience
	// (pre-qualify already wrote it — one experience pull per funnel), fills the Person, and moves the
	// Lead to "To qualify". Idempotent.
	enrich: async (profile: string) => {
		const u = profileUrl(publicIdOf(profile));
		const status = await leadStatus(u);
		if (status === "Not qualified" || rank(status) >= rank("Qualification pending approval"))
			return { publicId: publicIdOf(profile), skipped: true, status };
		const { publicId, card, posts, comments } = await getProfileRest(profile);
		const name = card.name ?? publicId;
		const person: People = {
			Name: name,
			Headline: card.headline ?? undefined,
			About: card.about ?? undefined,
			Location: card.location ?? undefined,
			"LinkedIn URL": u,
			Updated: new Date().toISOString(),
			Activity:
				posts.posts.length || comments.comments.length
					? stringify({ posts: posts.posts, comments: comments.comments }, { lineWidth: 0 })
					: undefined
		};
		const p = await store.upsert(config.models.People, person, "LinkedIn URL");
		const lead: Leads = { Name: name, Person: [p.id], "LinkedIn URL": u, Status: "To qualify" };
		const l = await store.upsert(config.models.Leads, lead, "LinkedIn URL");
		return { person: p.url, lead: l.url, publicId, name, posts: posts.posts.length, comments: comments.comments.length };
	},

	// qualify — the LLM judge against the soft-ICP contract; Lead moves to the human gate.
	qualify: (profile: string) => decider.decide("qualify", publicIdOf(profile)),

	// context — the read half of the judgment (contract + frozen evidence), for a manual judge.
	// (Reviewing Decisions — list/show — is the agent-agnostic `sflock decisions` surface.)
	context: (profile: string) => decider.context("qualify", publicIdOf(profile)),

	// check-lead-stages — the follow-up worklist: everyone whose Lead sits at `status`, each with the
	// LinkedIn URL (the sole key) you pass straight into the next stage command. One query, one table.
	checkLeadStages: async (status: string) => {
		const rows = await store.query(config.models.Leads, { property: "Status", select: { equals: status } });
		return rows.map((r) => ({ name: r.fields.Name, url: r.fields["LinkedIn URL"] }));
	}
};
