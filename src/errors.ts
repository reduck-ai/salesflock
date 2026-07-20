// One error renderer — every tool's failure path prints through it, so an error is loud and
// complete instead of a flattened one-liner. It walks the whole causal chain (a native `cause`,
// and the AI SDK's `lastError`, which a RetryError hides the real failure behind) and surfaces
// the fields `.message` drops: an HTTP error's status + url, and the terminal socket cause's
// `code` (ECONNRESET, "other side closed"). Full stacks + response bodies only under DEBUG.

const prop = (e: Error, k: string): unknown => (e as unknown as Record<string, unknown>)[k];

// The chain: the error, then its `cause`, then (for the AI SDK's RetryError) its `lastError` —
// depth- and cycle-capped so a self-referential cause can't loop forever. Deepest is the root.
const chain = (e: unknown): Error[] => {
	const out: Error[] = [];
	let cur = e;
	while (cur instanceof Error && out.length < 8 && !out.includes(cur)) {
		out.push(cur);
		cur = prop(cur, "cause") ?? prop(cur, "lastError");
	}
	return out;
};

// The one clause that says WHY: an AI/HTTP error's status + url, or a socket error's code.
const detail = (e: Error): string => {
	const bits = [
		prop(e, "statusCode") && `status ${prop(e, "statusCode")}`,
		prop(e, "url"),
		prop(e, "code") && `code ${prop(e, "code")}`
	].filter(Boolean);
	return bits.length ? ` (${bits.join(", ")})` : "";
};

// renderError(e) → a multi-line string: each layer as `name: message (detail)`, the root cause
// last. Under DEBUG it appends the root's response body and stack.
export const renderError = (e: unknown): string => {
	const layers = chain(e);
	if (!layers.length) return `error: ${String(e)}`;
	// name only when it adds information — a bare "Error" is noise, "AI_APICallError" isn't.
	const tag = (l: Error) => (l.name && l.name !== "Error" ? `${l.name}: ` : "");
	const lines = layers.map(
		(l, i) => `${i ? "  ↳ caused by " : "error: "}${tag(l)}${l.message}${detail(l)}`
	);
	if (process.env.DEBUG) {
		const root = layers[layers.length - 1];
		const body = prop(root, "responseBody");
		if (body) lines.push(`  response: ${String(body).slice(0, 2000)}`);
		if (root.stack) lines.push(root.stack);
	}
	return lines.join("\n");
};
