// The reduck scripts on Google's surface. `sflock bind --client google` generates
// google.schema.ts; composers (lk.searchProfiles) import both. Addresses live ONLY here.

export const scripts = {
	search: "reduck/google.com/search_site"
} as const;
