// The live operator trace — the one diagnostic seam. Writes to stderr (stdout is the result),
// each line tagged so concurrent runs stay attributable. No levels, no store, no collection:
// it's emitted where it happens, so it survives a stall and shows WHERE it stalled. The reader
// is the agent driving these tools — it reads the answer on stdout and how-it-went here.

export const log = (tag: string, msg: string): void => console.error(`[${tag}] ${msg}`);
