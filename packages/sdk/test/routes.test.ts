import { openApiDocument } from "@keeltown/contracts";
import { describe, expect, it } from "vitest";
import { ROUTES, UNROUTED } from "../src/routes.ts";

interface Parameter {
  readonly name: string;
  readonly in: string;
}

const isParameter = (value: unknown): value is Parameter =>
  typeof Reflect.get(Object(value), "name") === "string" &&
  typeof Reflect.get(Object(value), "in") === "string";

/** The document's parameters for one operation, by where they travel; `$ref`s resolved. */
function parametersOf(operation: { readonly parameters?: readonly unknown[] }) {
  const resolved = (operation.parameters ?? []).flatMap((parameter): Parameter[] => {
    const ref = Reflect.get(Object(parameter), "$ref");
    const found =
      typeof ref === "string"
        ? Reflect.get(
            Object(openApiDocument.components?.parameters),
            ref.replace("#/components/parameters/", ""),
          )
        : parameter;
    if (!isParameter(found)) throw new Error(`unreadable parameter ${JSON.stringify(parameter)}`);
    return [found];
  });
  // A query or path name is the SDK's input key, so its case counts; a header's never does.
  const where = (place: string, name: (p: Parameter) => string = (p) => p.name) =>
    resolved
      .filter((p) => p.in === place)
      .map(name)
      .toSorted();
  return {
    query: where("query"),
    header: where("header", (p) => p.name.toLowerCase()),
    path: where("path"),
  };
}

/** Every operation id in the published document. */
const documented = Object.values(Object(openApiDocument.paths)).flatMap((item) =>
  Object.values(Object(item)).flatMap((operation) => {
    const id = Reflect.get(Object(operation), "operationId");
    return typeof id === "string" ? [id] : [];
  }),
);

describe("the SDK's routes", () => {
  it("[sdk.routes-total] routes every operation in the document, but those it names as unrouted", () => {
    expect(documented.length).toBeGreaterThan(40);
    expect(Object.keys(ROUTES).filter((op) => op in UNROUTED)).toEqual([]);
    expect([...Object.keys(ROUTES), ...Object.keys(UNROUTED)].toSorted()).toEqual(
      documented.toSorted(),
    );
  });

  it.each(Object.entries(ROUTES))(
    "[sdk.routes] %s is where the published document says, with the same parameters",
    (operationId, route) => {
      const item = Reflect.get(Object(openApiDocument.paths), route.path);
      const operation = Reflect.get(Object(item), route.method.toLowerCase());
      expect(Reflect.get(Object(operation), "operationId")).toBe(operationId);
      const parameters = parametersOf(Object(operation));
      expect(parameters.query).toEqual(("query" in route ? [...route.query] : []).toSorted());
      expect(parameters.header).toEqual(("headers" in route ? [...route.headers] : []).toSorted());
      const templated = [...route.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? "");
      expect(parameters.path).toEqual(templated.toSorted());
    },
  );
});
