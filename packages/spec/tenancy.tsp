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

  /** Absent until the user chooses one; it never changes. */
  handle?: Handle;

  /** The user's own namespace, where their own projects live: present once they have a handle. It has no members. */
  `namespace`?: NamespaceRef;

  /** The orgs the user is a member of, in org id order: never their own namespace. */
  orgs: UserOrg[];
}

/** A namespace: a handle that owns projects. Its id is its account's. */
model NamespaceView {
  id: NamespaceId;
  handle: Handle;
  kind: NamespaceKind;
}

@tag("Namespaces")
@route("/namespaces")
interface Namespaces {
  /** Whose a handle is: a person's, an agent's or an org's. Handles are public, and one is found in any case. */
  @summary("Get a namespace by its handle")
  @useAuth(NoAuth | AgentRead | SessionAuth)
  @route("/{handle}")
  @get
  getNamespace(@path handle: string): NamespaceView | NotFound | StandardErrors;

  /**
   * A project by its namespace's handle and its own name, as `/<namespace>/<project>` names them; either in any case.
   * A private project reads as missing to anyone outside its namespace.
   */
  @summary("Get a project by its namespace and name")
  @useAuth(NoAuth | AgentRead | SessionAuth)
  @route("/{handle}/projects/{name}")
  @get
  getProject(@path handle: string, @path name: string): ProjectView | NotFound | StandardErrors;
}

@tag("Users")
@route("/users")
interface Users {
  /** The signed-in user: its handle, its own namespace, and its orgs with its role in each. */
  @summary("Who am I, as a user?")
  @useAuth(SessionAuth)
  @route("/me")
  @get
  me(): UserIdentity | StandardErrors;
}
