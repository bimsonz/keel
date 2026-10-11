import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AccountApp } from "./account/AccountApp.tsx";
import { App } from "./App.tsx";
import { placeOf } from "./places.ts";
// oxlint-disable-next-line import/no-unassigned-import -- a stylesheet
import "./styles.css";

const root = document.getElementById("root");
if (root === null) throw new Error("missing #root");

// A page above every project is the user's own, and reads nothing of Keel's log; everything else is the console.
const place = placeOf(window.location.pathname, window.location.search);

createRoot(root).render(
  <StrictMode>{place === null ? <App /> : <AccountApp place={place} />}</StrictMode>,
);
