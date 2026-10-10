import { a } from "./a.ts";

export const b = (): string => (Math.random() > 2 ? a() : "b");
