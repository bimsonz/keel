### Fixed

- A change whose agent's lease lapsed reads the same in Mission Control and the pipeline as in the list of changes: "Waiting on its agent", in grey, with no time counted and not among the live changes. Mission Control had drawn it red as stuck, with a timer of hours, and the pipeline had flagged it with Keel's token `lease-lapsed`. A change parked on a question still reads as awaiting a ruling.
