### Fixed

- **An ended proposal gives its fork's repo bytes back.** What a proposal copies into its workspace is counted against its fork's namespace, and was never given back, though its workspace is collected once it lands, is closed or superseded. The proposal's object now keeps what each copy admitted and, once the proposal has ended, gives it back under `proposal-giveback:<change>`, once. Proposals opened before this release give nothing back.
