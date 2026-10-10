// Control for xstate-test-only: a domain machine runs on xstate instead of
// reading its chart as test data, statically and through a dynamic import.
import { createMachine } from "xstate";

export const machine = createMachine({ id: "change", initial: "declared", states: {} });
export const inspector = await import("@xstate/inspect");
