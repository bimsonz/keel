// Control for R4: a and b import each other, a cycle.
import { b } from "./b.ts";

export const a = (): string => `a${b()}`;
