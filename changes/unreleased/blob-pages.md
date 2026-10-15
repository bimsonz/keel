### Added

- **A large file is read a page at a time.** `Repo_getBlob` served any text file up to 1 MiB whole, and an agent that read `openapi.json` (740 KB) ran out of room. A text file over 64 KiB now comes a page of whole lines at a time: `lines {start, end, total}` says which lines `content` holds, `nextStartLine` where the next page starts, and `next` is the call that reads it (`startLine`, a new query). A smaller file comes whole, as before.
