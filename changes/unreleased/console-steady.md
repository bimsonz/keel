### Fixed

- A project's Code page is read at Keel's own head while the log is still being read, rather than once more at every head the log passes on its way. On a busy project the files no longer wait for the whole log, and its About column waits until the log is read rather than counting part of it.
- "Bounced" means one thing on Changes, Pipeline and Mission Control: from Keel's bounce until the change moves on, submitted again or adopted, whether or not its agent is still there to revise it.
- A new project's trunk shows its first commit in Mission Control and the pipeline, not a dash.
- A person's own profile no longer asks for an org by their handle.
