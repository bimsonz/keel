import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AccountApp } from "./account/AccountApp.tsx";
import { App } from "./App.tsx";
import { legalOf } from "./legal/legal.ts";
import { LegalPage } from "./legal/LegalPage.tsx";
import { hrefOf, placeOf } from "./places.ts";
// oxlint-disable-next-line import/no-unassigned-import -- a stylesheet
import "./styles.css";

const root = document.getElementById("root");
if (root === null) throw new Error("missing #root");

// The terms and the privacy notice are anyone's to read, and ask Keel nothing. A page above every project is
// the user's own, and reads nothing of Keel's log; everything else is the console.
const legal = legalOf(window.location.pathname);
const place = placeOf(window.location.pathname, window.location.search);
// An org's home was once at `/orgs/<org>`. It is at its handle, and an address of the old kind is corrected.
if (place?.at === "namespace" && window.location.pathname !== hrefOf(place))
  window.history.replaceState(null, "", `${hrefOf(place)}${window.location.search}`);

createRoot(root).render(
  <StrictMode>
    {legal !== null ? (
      <LegalPage which={legal} />
    ) : place === null ? (
      <App />
    ) : (
      <AccountApp place={place} />
    )}
  </StrictMode>,
);
