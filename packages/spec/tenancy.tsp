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

  /** Whether the user is this instance's admin. */
  instanceAdmin: boolean;

  /** The orgs the user belongs to, in org id order. */
  orgs: UserOrg[];
}

model CreateUserRequest {
  /** The new user's handle; its personal org takes the same name. */
  handle: Handle;
}

/** A user's bearer session, shown once: present it as `Authorization: Bearer <token>`. */
model SessionGrant {
  token: string;
  expiresAt: utcDateTime;
}

model CreatedUser {
  userId: UserId;
  handle: Handle;

  /** The user's personal org, named by its handle. */
  org: OrgId;

  session: SessionGrant;
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
  /** The signed-in user: its handle, whether it is the instance admin, and its orgs with its role in each. */
  @summary("Who am I, as a user?")
  @useAuth(SessionAuth)
  @route("/me")
  @get
  me(): UserIdentity | StandardErrors;
}

@tag("Admin")
@route("/admin")
interface Admin {
  /**
   * A user with a handle and its personal org, and a bearer session for it, shown once: how automation
   * gets a user. The instance admin, or the bootstrap credential, may call it. A handle already taken or
   * held answers 409.
   */
  @summary("Create a user")
  @useAuth(SessionAuth | BootstrapAuth)
  @route("/users")
  @post
  createUser(@body body: CreateUserRequest): {
    @statusCode statusCode: 201;
    @body body: CreatedUser;
  } | Conflict | StandardErrors;
}
