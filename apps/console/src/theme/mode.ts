// Kumo resolves its tokens with light-dark() from `data-mode`, and has no
// prefers-color-scheme rule, so the app sets the attribute itself.

export type Mode = "dark" | "light";

export function applyMode(mode: Mode): void {
  document.documentElement.dataset["mode"] = mode;
}
