// The tools that earn a TS layer — they do what `reduck run` alone can't: fetch a
// LinkedIn entity and write it to the CRM, or set up a Lead by joining two records that
// are already there. Fetch + compose lives in the Lk client; the record mapping — the
// one model-specific bit — lives here, then goes to notion.upsert directly.

import { readFile } from "node:fs/promises";
import {
	searchProfiles as lkSearchProfiles,
	getProfile as lkGetProfile,
	getCompany as lkGetCompany,
	publicIdOf
} from "../../src/clients/lk.js";
import * as notion from "../../src/clients/notion.js";
import * as gemini from "../../src/clients/gemini.js";
import type { People } from "./schema/People.js";
import type { Companies } from "./schema/Companies.js";
import type { Leads } from "./schema/Leads.js";
import type { Sourcing } from "./schema/Sourcing.js";
import type { Decisions } from "./schema/Decisions.js";

// A data source, named once by env. Each destination is a distinct id; no default.
const ds = (name: string): string => {
	const id = process.env[name];
	if (!id) throw new Error(`set ${name} to the destination data-source id`);
	return id;
};

// A LinkedIn company's headquarters → a one-line HQ string, or undefined if it has none.
const hq = (h: { city?: string | null; geographicArea?: string | null; country?: string | null } | null | undefined) =>
	(h && [h.city, h.geographicArea, h.country].filter(Boolean).join(", ")) || undefined;

export const tools = {
	// search — discover LinkedIn profiles via one Google run. Per hit: a Person stub
	// (idempotent on the canonical LinkedIn URL) and, only for a NEW person, a Lead at the
	// pipeline start — re-searching someone already in the pipeline must not reset their
	// Status. Then ONE Sourcing row for the run itself — an append-only log (each run is a
	// distinct event, so Ran at is in the key) linking the People it yielded, new or not.
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
			const p = await notion.upsert(ds("NOTION_PEOPLE_DS"), person, "LinkedIn URL");
			personIds.push(p.id);
			if (p.created) {
				const lead: Leads = { Name: hit.name, Person: [p.id], Status: "To enrich" };
				await notion.upsert(ds("NOTION_LEADS_DS"), lead, "Name");
			}
			out.push({ publicId: hit.publicId, name: hit.name, person: p.url, created: p.created });
		}
		const sourcing: Sourcing = {
			Key: `${ranAt} ${script} ${query}`,
			Script: script,
			Args: JSON.stringify(args),
			"Ran at": ranAt,
			People: personIds
		};
		await notion.upsert(ds("NOTION_SOURCING_DS"), sourcing, "Key");
		return out;
	},

	// enrich — assemble the LinkedIn profile (three runs), fill the Person in (idempotent
	// on the same canonical /in/ URL search writes, NOT card.profileUrl — one key, one page),
	// and move their Lead forward to "To qualify" (created there if the person never went
	// through search: the state converges to reality). Name-keyed Lead, like put-lead.
	enrich: async (profile: string) => {
		const { publicId, card, experience } = await lkGetProfile(profile);
		const name = card.name ?? publicId;
		const person: People = {
			Name: name,
			Headline: card.headline ?? undefined,
			About: card.about ?? undefined,
			Location: card.location ?? undefined,
			"LinkedIn URL": `https://www.linkedin.com/in/${publicId}`,
			Updated: new Date().toISOString(),
			Experiences: experience.positions
				.map((p) => [[p.title, p.company].filter(Boolean).join(" — "), p.dateRange].filter(Boolean).join(" · "))
				.join("\n")
		};
		const p = await notion.upsert(ds("NOTION_PEOPLE_DS"), person, "LinkedIn URL");
		const lead: Leads = { Name: name, Person: [p.id], Status: "To qualify" };
		const l = await notion.upsert(ds("NOTION_LEADS_DS"), lead, "Name");
		return { person: p.url, lead: l.url, publicId, name, positions: experience.positions.length };
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
		const { id, url, created } = await notion.upsert(ds("NOTION_COMPANIES_DS"), row, "LinkedIn URL");
		return { where: url, id, created, companyId: c.companyId, name: c.name };
	},

	// qualify — the judgment: a pure function of frozen context, never a fetch. Evidence is
	// what the CRM holds for the person, rendered as Markdown; criteria are the prompt +
	// knowledge/ files; the judge is Gemini at temperature 0. The verdict is a Decision
	// page — "<Person> - Lead Qualification", the CURRENT decision at this gate, converging
	// on its title. Everything is a property, for UIs to bind: Decision, Reasoning,
	// Evidence (Markdown, for a custom card), and Prompt (with ICP; evidence stays out, so
	// the judge's exact input reconstructs by substitution). The Lead gains the dual
	// backlink and moves to the human gate.
	qualify: async (profile: string) => {
		const publicId = publicIdOf(profile);
		const url = `https://www.linkedin.com/in/${publicId}`;
		const person = await notion.read(ds("NOTION_PEOPLE_DS"), "LinkedIn URL", url);
		const f = person.fields;
		const evidence = ["Name", "Headline", "Location", "About", "Experiences"]
			.filter((k) => f[k])
			.map((k) => `### ${k}\n\n${f[k]}`)
			.join("\n\n");
		const [template, company, icp] = await Promise.all(
			["prompts/qualify.md", "knowledge/company.md", "knowledge/icp.md"].map((p) =>
				readFile(`agents/linkedin-leads/${p}`, "utf8")
			)
		);
		const prompt = template.replace("{{company}}", company).replace("{{icp}}", icp);
		const verdict = await gemini.generate<{ reasoning: string; decision: NonNullable<Decisions["Decision"]> }>(
			prompt.replace("{{evidence}}", evidence),
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
		const l = await notion.upsert(ds("NOTION_LEADS_DS"), lead, "Name");
		const d = await notion.upsert(
			ds("NOTION_DECISIONS_DS"),
			{
				Name: `${name} - Lead Qualification`,
				Decision: verdict.decision,
				Reasoning: verdict.reasoning,
				Evidence: evidence,
				Prompt: prompt,
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
			Name: await notion.pageTitle(personId),
			Person: [personId],
			...(companyId ? { Company: [companyId] } : {}),
			Status: "To enrich"
		};
		const { id, url, created } = await notion.upsert(ds("NOTION_LEADS_DS"), lead, "Name");
		return { where: url, id, created };
	}
};
