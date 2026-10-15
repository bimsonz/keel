### Fixed

- A project's link card no longer falls back to the site's on a cold read: a crawler waits up to two seconds for Keel's read of the project, and a read that takes longer goes on and is kept, so the next crawler is given the project's card. Only Keel's own answer is kept: a read that fails or meets Keel away is asked again.
