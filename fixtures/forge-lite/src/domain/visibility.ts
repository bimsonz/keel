export const VISIBILITIES = ["public", "private"] as const;

export type Visibility = (typeof VISIBILITIES)[number];

export function isVisibility(value: unknown): value is Visibility {
  return value === "public" || value === "private";
}
