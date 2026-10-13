// Keel's wire types: every request, response and model of its API, and every
// event in its catalogue, as Keel's own generator emits them from its spec.
// Everything in this console that names a wire type imports it from here.

export type * from "@keeltown/contracts";

// The first segments Keel serves itself and refuses as a handle: one list, Keel's, which the route table reads.
export { RESERVED_SEGMENTS } from "@keeltown/contracts";
