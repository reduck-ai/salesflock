// The tools that earn a TS layer — they do what `reduck run` alone can't: fetch a
// LinkedIn entity and write it to the CRM, or set up a Lead by joining two records that
// are already there. Fetch + compose lives in the Lk client; the record mapping — the
// one model-specific bit — lives here, then goes to the store's upsert directly.

import {
	searchProfiles as lkSearchProfiles,
	getProfile as lkGetProfile,
	getCompany as lkGetCompany,
	publicIdOf,
	type Profile
} from "../../src/clients/lk/index.js";
import { getStore } from "../../src/stores/index.js";
import * as gemini from "../../src/ai/gemini.js";
import config from "./config.js";
import type { People } from "./schema/People.js";
import type { Companies } from "./schema/Companies.js";
import type { Leads } from "./schema/Leads.js";
import type { Sourcing } from "./schema/Sourcing.js";
import type { Decisions } from "./schema/Decisions.js";

// The store this agent writes to and the tables it addresses — both chosen in config.ts
// (notion by default). No env: the model→table map and prompt rows all live in one file.
const store = getStore(config.destination);

// A LinkedIn company's headquarters → a one-line HQ string, or undefined if it has none.
const hq = (h: { city?: string | null; geographicArea?: string | null; country?: string | null } | null | undefined) =>
	(h && [h.city, h.geographicArea, h.country].filter(Boolean).join(", ")) || undefined;

// One line per item, tight enough to read as evidence. A repost shows who authored the
// original; a comment shows the post it replied to. Truncated to keep the field skimmable.
const clip = (s: string | null | undefined, n: number): string =>
	!s ? "" : s.replace(/\s+/g, " ").trim().slice(0, n) + (s.length > n ? "…" : "");

// The activity lens as Markdown: what the person posts and where they comment — the ICP's
// "entrepreneurial, active on LinkedIn" signal. undefined when they do neither.
const activity = (posts: Profile["posts"]["posts"], comments: Profile["comments"]["comments"]): string | undefined => {
	const p = posts.map((x) => {
		const repost = x.repostedBy && x.author && x.author !== x.repostedBy ? `↻ ${x.author}: ` : "";
		const meta = [x.postedAgo, x.reactions && `${x.reactions} reactions`].filter(Boolean).join(" · ");
		return `- ${meta ? meta + " — " : ""}${repost}${clip(x.text, 240) || "(no text)"}`;
	});
	const c = comments.map(
		(x) => `- ${x.postedAgo ?? ""} on ${x.post.author ?? "?"}'s post: ${clip(x.text, 180)} — re: "${clip(x.post.text, 100)}"`
	);
	const out = [p.length && `#### Posts\n${p.join("\n")}`, c.length && `#### Comments\n${c.join("\n")}`].filter(Boolean);
	return out.length ? out.join("\n\n") : undefined;
};

export const tools = {
	// search — discover LinkedIn profiles via one Google run. Per hit: a Person stub
	// (idempotent on the canonical LinkedIn URL) and, only for a NEW person, a Lead at the
	// pipeline start — re-searching someone already in the pipeline must not reset their
	// Status. Then ONE Sourcing row for the run — an append-only log (each run is a distinct
	// event, so the generated name carries the run time, human-readably) linking the People
	// it yielded, new or not.
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
				await store.upsert(config.models.Leads, lead, "Name");
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

	// enrich — assemble the LinkedIn profile (three runs), fill the Person in (idempotent
	// on the same canonical /in/ URL search writes, NOT card.profileUrl — one key, one page),
	// and move their Lead forward to "To qualify" (created there if the person never went
	// through search: the state converges to reality). Name-keyed Lead, like put-lead.
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
			Experiences: experience.positions
				.map((p) => {
					const head = [[p.title, p.company].filter(Boolean).join(" — "), p.dateRange, p.location]
						.filter(Boolean)
						.join(" · ");
					return p.description ? `${head}\n${p.description}` : head;
				})
				.join("\n\n"),
			Activity: activity(posts.posts, comments.comments)
		};
		const p = await store.upsert(config.models.People, person, "LinkedIn URL");
		const lead: Leads = { Name: name, Person: [p.id], Status: "To qualify" };
		const l = await store.upsert(config.models.Leads, lead, "Name");
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

	// get-company — pull the LinkedIn company (one run), map to a Company, upsert (idempotent
	// on "LinkedIn URL"). Returns the ref plus companyId — the stable join key downstream.
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

	// qualify — the judgment: a pure function of frozen context, never a fetch. Evidence is
	// what the CRM holds for the person, rendered as Markdown; criteria live in the Prompts
	// table — config.prompts.qualify names the row, and changing the prompt means a new row,
	// so a Decision's Prompt relation always points at the exact text the judge saw. The
	// judge's input is System prompt + Instruction + Evidence — non-overlapping, stored
	// once each, so it reconstructs by concatenation. The verdict is a Decision page —
	// "<Person> - Lead Qualification", the CURRENT decision at this gate, converging on its
	// title. The Lead gains the dual backlink and moves to the human gate; Accepted,
	// Ground truth and Feedback are the human's — never written here.
	qualify: async (profile: string) => {
		const publicId = publicIdOf(profile);
		const url = `https://www.linkedin.com/in/${publicId}`;
		const person = await store.read(config.models.People, "LinkedIn URL", url);
		const f = person.fields;
		const evidence = ["Name", "Headline", "Location", "About", "Experiences", "Activity"]
			.filter((k) => f[k])
			.map((k) => `### ${k}\n\n${f[k]}`)
			.join("\n\n");
		const prompt = await store.read(config.models.Prompts, "Name", config.prompts.qualify);
		const [system, instruction] = ["System prompt", "Instruction"].map((k) => {
			if (!prompt.fields[k]) throw new Error(`prompt "${config.prompts.qualify}" has no ${k}`);
			return String(prompt.fields[k]);
		});
		const verdict = await gemini.generate<{ reasoning: string; decision: string }>(
			[system, instruction, `## Evidence\n\n${evidence}`].join("\n\n"),
			{
				type: "object",
				required: ["reasoning", "decision"],
				properties: {
					reasoning: { type: "string" },
					decision: { type: "string", enum: ["Qualified", "Not qualified"] }
				}
			}
		);
		const name = String(f.Name ?? publicId);
		const lead: Leads = { Name: name, Person: [person.id], Status: "Qualification pending approval" };
		const l = await store.upsert(config.models.Leads, lead, "Name");
		const d = await store.upsert(
			config.models.Decisions,
			{
				Name: `${name} - Lead Qualification`,
				Decision: verdict.decision,
				Reasoning: verdict.reasoning,
				Evidence: evidence,
				Prompt: [prompt.id],
				Lead: [l.id]
			} satisfies Decisions,
			"Name"
		);
		return { decision: verdict.decision, reasoning: verdict.reasoning, where: d.url };
	},

	// put-lead — the join: a Lead is a person, so it needs only that person; its Name is
	// derived from the Person it points at. companyId is optional (the person's company,
	// when known). Idempotent on Name. personId/companyId are the ids the get-* tools return.
	putLead: async ({ personId, companyId }: { personId: string; companyId?: string }) => {
		const lead: Leads = {
			Name: await store.title(config.models.People, personId),
			Person: [personId],
			...(companyId ? { Company: [companyId] } : {}),
			Status: "To enrich"
		};
		const { id, url, created } = await store.upsert(config.models.Leads, lead, "Name");
		return { where: url, id, created };
	}
};
