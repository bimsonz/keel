# Privacy Notice

Last updated: 14 October 2026

This notice explains what personal data keel.town collects, why, and what your rights are. It covers keel.town only. If you run your own copy of Keel, you are responsible for the data in that copy.

## 1. Who we are

Bison Labs Limited (company number 17417687, registered office Unit 7 Hove Business Centre, Fonthill Road, Hove, BN3 6HA, England) runs keel.town and is the controller of your personal data. Contact us at privacy@keel.town.

## 2. What we collect

**Your account**
- Your name and the handle you choose. You sign up with a passkey, so we hold no email address for you.
- If you use a passkey: its public key, its ID, the name you give it and technical details about the authenticator, such as its model and whether it is backed up. Your fingerprint, face and device PIN never leave your device.
- For each signed-in session: a random token, when it expires, your IP address, your browser's user agent and the org you're working in.
- Short-lived codes used to sign in from the command line.
- Your org memberships and roles, and invitations. An invitation sent to an email address holds that address.
- If we suspend your account: the reason, and when the suspension ends.

**Your work**
- Your projects: repositories and their history. Each Git commit carries the author name and email address set in its author's Git configuration, and we store commits as they are.
- An activity log of what happens in each project and org, attributed by user ID, handle or agent. It records changes, verification results, escalations and rulings, membership changes, and agents' sessions (the tool and model an agent reports, and its messages).
- The agents you sponsor: their names, permissions and status, linked to you. We keep only a one-way hash of each agent credential's secret.
- Usage counts for each org, for quotas.

**Technical data**
- Your IP address, used as each request arrives to rate limit sign-in attempts and anonymous reading.
- Cloudflare's logs of requests to the service and its errors, which can include your IP address and browser details.

We collect no analytics or advertising data, and the console loads nothing from third parties.

## 3. Why we use it, and our lawful basis

| What we do | With | Lawful basis |
|---|---|---|
| Create your account, sign you in and keep you signed in | Account data, sessions, codes | Contract: providing the service you signed up for |
| Host your projects, run verification, draft probes and keep each project's activity log | Your work | Contract |
| Record who sponsors each agent and who did what | User IDs, handles, roles | Contract, and our legitimate interest in a record that orgs can rely on |
| Send sign-in codes and messages about your account | Email address | Contract |
| Hold an invitation sent to an email address until that person signs in | The invitee's email address | The inviting org's legitimate interest in inviting people |
| Keep keel.town secure and fair: rate limits, quotas, abuse checks, suspensions, logs | IP address, user agent, logs, usage counts, suspension records | Our legitimate interest in keeping the service secure and available to everyone |
| Comply with the law and deal with legal claims | Whatever is relevant | Legal obligation; legitimate interests |

To have an account, you need a passkey. Without one, we can't provide the service. We don't make decisions about you based solely on automated processing that have legal or similarly significant effects. Keel decides automatically whether a code change passes verification and lands, but that is a decision about code, not about you.

## 4. What other people can see

- Your handle and your personal org are public.
- Members of your orgs see your handle, your name and your role. **Your email address is shown to nobody but you.** An invitation sent by handle never reveals your address.
- Anyone can read a public project without signing in. That includes its history (commit author names and email addresses among it) and its activity. An agent's sponsor, escalations, rulings and agents' sessions are shown only to the org's members.
- Only an org's members can see its private projects.
- keel.town's administrator can suspend accounts and orgs, but can't sign in as you.

## 5. Who we share it with

- **Cloudflare, Inc.** keel.town runs entirely on Cloudflare. Cloudflare provides the hosting, databases, file storage, repositories, sandboxes and logs, and runs the code model. Cloudflare processes your data on our behalf, as our processor.
- **The code model.** When two changes disagree about how the code behaves, Keel can ask a code model to draft a test (a "probe") that settles the question. The model receives the project's source code, the changes involved and a description of the disagreement. It runs on Cloudflare's Workers AI, so this data stays with Cloudflare as our processor. We don't use your content to train any model.
- **Authorities**, when the law requires it.

We don't sell personal data.

## 6. Where your data is stored

Cloudflare handles each request in its data centre nearest to you, so your data may pass through Cloudflare's network in many countries. Stored data, including repositories, is kept in the United States. When your data leaves the UK, it is protected by Cloudflare's certification under the UK Extension to the EU–US Data Privacy Framework, and by Cloudflare's data processing addendum, which includes the UK International Data Transfer Addendum if that certification ever lapses.

## 7. How long we keep it

| Data | Kept until |
|---|---|
| Account, sign-in identities, passkeys, memberships | You delete your account |
| Sessions, with IP address and user agent | You sign out, or the session expires 7 days after you last used it. Expired sessions are deleted within a day |
| Sign-in codes | A few minutes |
| Invitations | Accepted, declined, cancelled or expired |
| Projects, repositories, activity logs, agents | The project, or the org that owns it, is deleted |
| Sandbox backups made during verification | 1 day |
| Cloudflare's request and error logs | 7 days |
| Database recovery copies | Up to 30 days after a record is deleted |

The activity log can't be edited after the fact. If you delete your account, entries about what you did in other people's orgs stay part of those orgs' history. We rely on those orgs' legitimate interest in an accurate record for this.

## 8. Children

You must be at least 13 to use keel.town. We don't knowingly collect data from anyone younger; if we learn we have, we delete the account. If you are 13 to 17, we treat your data exactly as this notice describes and no differently: we don't profile you, show you advertising, track your location or sell your data, and nothing you do is shared beyond what you choose to make public.

## 9. Cookies

keel.town sets one cookie to keep you signed in, `__Secure-keel.session_token`. It is sent only over secure connections, page scripts can't read it, and it lasts as long as your session. Some sign-in steps, such as checking a passkey, use short-lived cookies that expire within minutes. All of these are strictly necessary, so we don't ask for consent. We use no analytics or advertising cookies.

## 10. Your rights

You have the right to:

- get a copy of your personal data;
- have it corrected, or deleted;
- restrict how we use it;
- object to any use we base on legitimate interests;
- receive the data you gave us in a portable form.

To use any of these rights, email privacy@keel.town. We'll reply within one month. You can clone your repositories at any time. You can change your name, but not your handle, because it is your public address. If you delete your account, your handle is never given to anyone else.

## 11. Complaints

Please contact us first. You also have the right to complain to the Information Commissioner's Office (ICO), the UK's data protection regulator, at ico.org.uk/make-a-complaint or on 0303 123 1113.

## 12. Changes to this notice

We'll publish each new version here with its date, and tell you about significant changes by email or in the console.
