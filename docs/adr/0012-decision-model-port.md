# Decision models sit behind a port that speaks the System One shape

Clef is reached only through the `DecisionModel` port. The port uses the System One request shape: a `state` plus up to 64 typed questions (`noul`, `choice`, `score`), returning per-option probabilities.

Because of that, any of these can be swapped in without touching a verification step:
- hosted Clef, Clef-flash or Clef-omni;
- a pinned, self-hosted Clef (Apache-2.0 weights, served by SGLang at `/v1/systemone`);
- TypeSafe's Jev.

**Keel keeps its own calibration ledger.** Probe outcomes and human rulings label Clef's answers, and thresholds are refitted per question and per model revision. AI Gateway's Evaluations feature is deprecated, so Keel has to own this.

Why:
- Thresholds are only meaningful against a pinned model revision, so a silent switch of the hosted model would invalidate them.
- Open weights let a deployment pin a version and get reproducible results.
- Typed questions with probabilities are exactly what a decision model is built to answer.
