import "@typespec/http";
import "./common.tsp";
import "./events.tsp";
import "./operator.tsp";

using Http;

namespace Keel;

/** One of a user's orgs, with the user's role there. */
model UserOrg {
  id: OrgId;
  name: string;
  role: OrgRole;
}

/** The signed-in user, as its session names it. */
model UserIdentity {
  userId: UserId;

  /** Absent until the user chooses one; its personal org takes the same name. */
  handle?: Handle;

  /** The orgs the user belongs to, in org id order. */
  orgs: UserOrg[];
}

@tag("Orgs")
@route("/orgs")
interface Orgs {
  /**
   * A project by its org's name and its own, as `/<org>/<project>` names them; either name in any case.
   * A private project reads as missing to anyone outside its org.
   */
  @summary("Get a project by its org and name")
  @useAuth(NoAuth | AgentRead | SessionAuth)
  @route("/{org}/projects/{name}")
  @get
  getProject(@path org: string, @path name: string): ProjectView | NotFound | StandardErrors;
}

@tag("Users")
@route("/users")
interface Users {
  /** The signed-in user: its handle, and its orgs with its role in each. */
  @summary("Who am I, as a user?")
  @useAuth(SessionAuth)
  @route("/me")
  @get
  me(): UserIdentity | StandardErrors;
}
