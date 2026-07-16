// The reduck scripts this client composes. `sflock bind --client lk` reads this to
// generate lk.schema.ts; lk.ts imports it for typed calls. Addresses live ONLY here —
// the keys name the generated types and the runtime handles.

export const scripts = {
	card: "reduck/linkedin.com/get_profile",
	experience: "reduck/linkedin.com/get_profile_experience",
	posts: "reduck/linkedin.com/get_profile_posts",
	comments: "reduck/linkedin.com/get_profile_comments",
	company: "reduck/linkedin.com/get_company_info"
} as const;
