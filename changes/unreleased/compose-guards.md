### Fixed

- **GitCore composes what git merges cleanly a side at a time, and reads a merge's changes side by side** (no route, event or migration).
  - **Renames.** A rename is now refused only where git would follow it to another result than the plain delete and add: when the other side changed its old path or its new one, or when the side emptied a whole directory and the other side changed something under it. It used to be refused wherever a batch deleted a path and added a similar one anywhere. On keel/keel that sent batches to MergeBox's cold box for eight minutes.
  - **Guards.** A mode change, a binary, a symlink or a gitlink is refused only on a path both sides changed. On one side alone, the merge takes that side, as git's does.
  - **Reads.** The diff between a member's base and the batch so far reads both trees, and every subtree that differs, side by side, and reads the guarded blobs side by side too. A path trunk changed since a member's base no longer costs an awaited read of each of its blobs.
