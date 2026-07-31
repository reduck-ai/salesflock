// The live channel behind the Writer: which open editors are watching which document, so a save can
// reach them without a reload. Deliberately the smallest thing that works — a Map of subscribers in
// THIS process, no broker, no persistence, no replay.
//
// In-process is not a shortcut, it is the shape of the feature: the publisher is a local `sflock docs
// push` hitting the local dev server, so publisher and subscriber are the same process by
// construction (the push gate itself is dev-only). A missed event is not a lost edit either — the
// document is on the Notion page regardless, and the editor's Pull button re-reads it.

// A subscriber gets the payload already serialized: every listener on a doc receives the same bytes,
// so stringify once at publish rather than per stream.
type Listener = (data: string) => void;

const watchers = new Map<string, Set<Listener>>();

// subscribe(id, fn) — start watching one document; the returned function stops (and drops the doc's
// entry when it was the last watcher, so an idle server holds nothing).
export const subscribe = (id: string, fn: Listener): (() => void) => {
	const set = watchers.get(id) ?? new Set<Listener>();
	watchers.set(id, set);
	set.add(fn);
	return () => {
		set.delete(fn);
		if (!set.size) watchers.delete(id);
	};
};

// publish(id, payload) — hand a document's new state to every editor watching it. Fire-and-forget: a
// broken stream is the stream's problem (its `cancel` unsubscribes), never the writer's.
export const publish = (id: string, payload: unknown): void => {
	const set = watchers.get(id);
	if (!set?.size) return;
	const data = JSON.stringify(payload);
	for (const fn of set) fn(data);
};
