import { type Route, TRUNK } from "../route.ts";
import { Link } from "../router.tsx";
import { Notice } from "../views/Frame.tsx";

const HOME: Route = { at: "code", kind: "tree", ref: TRUNK, path: "" };

/** An address that names nothing the console has. */
export function Missing() {
  return (
    <Notice title="There is nothing at this address">
      It may have been mistyped, or it may name something this console does not have.{" "}
      <Link to={HOME} className="a-link">
        Go to the project's code
      </Link>
    </Notice>
  );
}
