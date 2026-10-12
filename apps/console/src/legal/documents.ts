// The text of each document, as it stands in the repository (docs/legal). It is built into the page, so what
// is published is the text that was reviewed, word for word, and no request is made to read it.

import privacy from "../../../../docs/legal/privacy.md?raw";
import terms from "../../../../docs/legal/terms.md?raw";
import type { Legal } from "./legal.ts";

export const TEXT: Record<Legal, string> = { terms, privacy };
