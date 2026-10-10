# Only proof or a ruling can block; opinion is monotone

Evidence falls into four classes:
- **proof**: something Keel executed;
- **ruling**: a deterministic judgement over derived facts, or a human decision;
- **testimony**: a claim from outside Keel;
- **opinion**: any model output.

Only proof and rulings can fail or clear a change. The flow compiler enforces two typing rules:
- **Opinion steps may only escalate, annotate or abstain.** Opinion can add scrutiny but can never remove it.
- **Taint.** A step's effective evidence class is the weakest class it consumed. A plugin that consults a model becomes opinion.

A model-raised conflict is *proven* only by a discriminating probe. The probe must pass on trunk (or not apply there), pass in the premise-holder's world, fail in the combined world, and give the same result 3 runs in a row.

Why: models share blind spots, and errors are correlated even across model families, so a second model is not an independent witness. Letting opinion block would mean false positives stall agents. Letting opinion clear changes would wave regressions through.

## Consequences

- Undeclared effects block only when they are proof-class.
- Precedents never block by themselves; only guards do.
