import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { type Plugin, defineConfig } from "vite";
import { RESERVED } from "./src/route.ts";

/**
 * The code viewer and the graph are files of their own, asked for by the pages that draw them
 * (src/views/later.tsx). Left to the page's first script, each would be asked for only once that script had
 * come and run. So the page's HTML asks at once, beside that script, going by the address alone: a file, a
 * commit and a conflict for the viewer, and Mission Control for the graph. It is a hint and no more: a wrong
 * one costs a download, and the page draws the same.
 */
function early(): Plugin {
  return {
    name: "keel-console:early",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(_html, { bundle }) {
        const filesOf = (name: string): string[] => {
          const chunk = Object.values(bundle ?? {}).find(
            (built) => built.type === "chunk" && built.name === name,
          );
          if (chunk?.type !== "chunk")
            throw new Error(`${name} is no longer a file of its own: see src/views/later.tsx`);
          // Its own file and the ones it cannot run without, but for the page's first script, which is on its way.
          return [chunk.fileName, ...chunk.imports].filter(
            (file) => bundle?.[file]?.type === "chunk" && !bundle[file].isEntry,
          );
        };
        const hint = `(() => {
  const [first, project, place = ""] = location.pathname.split("/").filter((part) => part !== "");
  if (project === undefined || ${JSON.stringify(RESERVED)}.includes(first)) return;
  const files = ["mission-control", "subjects"].includes(place)
    ? ${JSON.stringify(filesOf("MissionGraph"))}
    : ["blob", "commit", "conflicts"].includes(place)
      ? ${JSON.stringify(filesOf("CodeDiff"))}
      : [];
  for (const file of files) {
    const link = document.createElement("link");
    link.rel = "modulepreload";
    link.href = "/" + file;
    document.head.append(link);
  }
})();`;
        return [{ tag: "script", injectTo: "head", children: hint }];
      },
    },
  };
}

// The page's build. The Worker is bundled by wrangler, and the tests are run by the root's vitest projects.
export default defineConfig({
  plugins: [react(), tailwindcss(), early()],
  server: { port: 5311, strictPort: true, host: true },
  preview: { port: 5311, strictPort: true, host: true },
  worker: { format: "es" },
});
