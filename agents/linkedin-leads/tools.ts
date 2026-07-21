// The tools that earn a TS layer — they do what `reduck run` alone can't: fetch a LinkedIn entity
// and write it to the CRM, or set up a Lead by joining two records. The generic judgment engine
// (judge → persist a Decision) lives in src/decide.ts; this file is the agent-specific wiring: the
// record mappings (search/enrich/get-company/put-lead) plus the decider bound to this agent's config.

import {
	searchProfiles as lkSearchProfiles,
	getProfile as lkGetProfile,
	getCompany as lkGetCompany,
	publicIdOf
} from "../../src/clients/lk/index.js";
import { getStore } from "../../src/stores/index.js";
import { createDecider } from "../../src/decide.js";
import { renderEvidence } from "../../src/linkedin/evidence.js";
import { projectInput } from "../../src/linkedin/project.js";
import { stringify } from "yaml";
import config from "./config.js";
import type { People } from "./schema/People.js";
import type { Companies } from "./schema/Companies.js";
import type { Leads } from "./schema/Leads.js";
import type { Sourcing } from "./schema/Sourcing.js";

// The store this agent writes to, and the decider bound to its config + the LinkedIn renderers.
const store = getStore(config.destination);
const decider = createDecider({ config, store, renderEvidence, projectInput });

// A LinkedIn company's headquarters → a one-line HQ string, or undefined if it has none.
const hq = (
	h: { city?: string | null; geographicArea?: string | null; country?: string | null } | null | undefined
) => (h && [h.city, h.geographicArea, h.country].filter(Boolean).join(", ")) || undefined;

export const tools = {
	// search — discover LinkedIn profiles via one Google run. Per hit: a Person stub (idempotent on
	// the canonical LinkedIn URL) and, only for a NEW person, a Lead at the pipeline start. Then ONE
	// Sourcing row for the run (append-only log), linking the People it yielded.
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
				const lead: Leads = { Name: hit.name, Person: [p.id], Status: "To enrich" };
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

	// enrich — assemble the LinkedIn profile (three runs), fill the Person in (idempotent on the same
	// canonical /in/ URL search writes), and move their Lead forward to "To qualify".
	enrich: async (profile: string) => {
		const { publicId, card, experience, posts, comments } = await lkGetProfile(profile);
		const name = card.name ?? publicId;
		const person: People = {
			Name: name,
			Headline: card.headline ?? undefined,
			About: card.about ?? undefined,
			Location: card.location ?? undefined,
			"LinkedIn URL": `https://www.linkedin.com/in/${publicId}`,
			Updated: new Date().toISOString(),
			Experiences: experience.positions.length
				? stringify(experience.positions, { lineWidth: 0 })
				: undefined,
			Activity:
				posts.posts.length || comments.comments.length
					? stringify({ posts: posts.posts, comments: comments.comments }, { lineWidth: 0 })
					: undefined
		};
		const p = await store.upsert(config.models.People, person, "LinkedIn URL");
		const lead: Leads = { Name: name, Person: [p.id], Status: "To qualify" };
		const l = await store.upsert(config.models.Leads, lead, "Person");
		return {
			person: p.url,
			lead: l.url,
			publicId,
			name,
			positions: experience.positions.length,
			posts: posts.posts.length,
			comments: comments.comments.length
		};
	},

	// get-company — pull the LinkedIn company (one run), map to a Company, upsert (idempotent on
	// "LinkedIn URL"). Returns the ref plus companyId — the stable join key downstream.
	getCompany: async (company: string) => {
		const c = await lkGetCompany(company);
		const row: Companies = {
			Name: c.name,
			"LinkedIn URL": c.linkedinUrl ?? undefined,
			Website: c.websiteUrl ?? undefined,
			Description: c.description ?? undefined,
			Tagline: c.tagline ?? undefined,
			Industry: c.industries?.[0],
			Headcount: c.employeeCount ?? undefined,
			Founded: c.foundedYear ?? undefined,
			HQ: hq(c.headquarters)
		};
		const { id, url, created } = await store.upsert(config.models.Companies, row, "LinkedIn URL");
		return { where: url, id, created, companyId: c.companyId, name: c.name };
	},

	// context — the read half of a decision (the contract + frozen evidence), for a manual judge.
	context: (key: string, profile: string) => decider.context(key, publicIdOf(profile)),

	// list — the decisions awaiting review (the queue).
	list: () => decider.list(),

	// show — one Decision by the shared id (id / Notion URL / app URL): the judge's judgment plus,
	// once ruled, the review diff.
	show: (handle: string) => decider.showDecision(handle),

	// qualify — one decide against the qualification contract: does this person fit the ICP?
	qualify: (profile: string) => decider.decide("qualify", publicIdOf(profile)),

	// engage — one decide against the engagement contract: how to open the relationship. Its effect
	// is outward, so when it follows a qualification, dependsOn holds it behind the upstream gate.
	engage: (profile: string, opts: { dependsOn?: string[] } = {}) =>
		decider.decide("engage", publicIdOf(profile), opts),

	// put-lead — the join: a Lead is a person, so it needs only that person; its Name is derived
	// from the Person it points at. Idempotent on Name.
	putLead: async ({ personId, companyId }: { personId: string; companyId?: string }) => {
		const lead: Leads = {
			Name: await store.title(config.models.People, personId),
			Person: [personId],
			...(companyId ? { Company: [companyId] } : {}),
			Status: "To enrich"
		};
		const { id, url, created } = await store.upsert(config.models.Leads, lead, "Person");
		return { where: url, id, created };
	}
};
