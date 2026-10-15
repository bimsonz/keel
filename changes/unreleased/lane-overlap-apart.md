### Changed

- **Changes whose footprints may share a path are batched apart** (no route or event). The Lane's batch planner keeps two queued changes out of one batch when some path could match a footprint glob of each (the kernel's `globsMayOverlap`: exact where either is a literal path), as it does two with an unsettled conflict. Speculation then forms the later one behind the earlier, composed on its candidate, so their overlap is an order and never a failed batch of several.
