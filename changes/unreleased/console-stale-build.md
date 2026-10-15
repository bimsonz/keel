### Fixed

- A page opened before a console deploy no longer draws nothing when it asks for a file the new build removed: the Worker answers a missing build file 404 instead of the page, and the page loads itself again once.
