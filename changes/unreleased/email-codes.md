### Added

- **Sign in with an email code** on keel.town. Keel sends each code through Email Service's `send_email` binding (`EMAIL`) as a plain text email from `KEEL_MAIL_FROM` ("Your Keel code is 123456. It expires in 5 minutes."), and offers email codes only where that var names an address. `scripts/deploy.ts` fills it as `noreply@mail.<host>`; an install leaves it empty and sends nothing. A refused send is logged by its error code alone, never the address.
