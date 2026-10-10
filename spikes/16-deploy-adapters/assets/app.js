// Asks the candidate whether the revoke route exists and says which world this is.
fetch("repos/x/y/collaborators/z", { method: "DELETE" }).then((r) => {
  const plain = (r.headers.get("content-type") || "").startsWith("text/plain");
  document.getElementById("world").textContent = r.status === 404 && plain ? "base (no revoke route)" : "A (revoke route present)";
});
