// The base capabilities — pointers to published @reduck scripts. DATA ONLY.
// Read each script's contract with `reduck read <addr>` for its exact args/output.

export interface Script {
	handle: string;
	host: string;
	slug: string;
}

export const scripts = {
	discover: { handle: "@reduck", host: "google.com", slug: "search_site" },
	post: { handle: "@reduck", host: "linkedin.com", slug: "get_post" },
	reactors: { handle: "@reduck", host: "linkedin.com", slug: "get_post_reactors" },
	profile: { handle: "@reduck", host: "linkedin.com", slug: "get_profile" },
	experience: { handle: "@reduck", host: "linkedin.com", slug: "get_profile_experience" },
	education: { handle: "@reduck", host: "linkedin.com", slug: "get_profile_education" },
	company: { handle: "@reduck", host: "linkedin.com", slug: "get_company_info" }
} as const satisfies Record<string, Script>;
