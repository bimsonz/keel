### Fixed

- **A lapse recorded while Keel held a change no longer parks it on its way back.** A change queued before a lease's deadline began running only while it waits on its agent could carry a lease recorded Lapsed while it was queued, and its next bounce parked it for adoption in the same moment. Such a lapse now does not stand: its holder's token still passes the lease check, nobody may adopt the change while Keel holds it, its holder still reads the lease, and the hand-back makes the same lease Active again with its 15 minutes starting from there.
