# Austin Realty: Bud execution and CRM hosting review

**Current commercial update, 14 September 2026:** [revision 32 customer offer](../outputs/austin-monday-2026-09-14/README.md) shows A$1,500 Mac hardware budget plus A$450 provisioning, A$15/month local off-site backup or A$60/month cloud hosting/backup. CRM setup is A$1,500; care A$149/month. These are proposed service pricing and planning budgets, subject to exact provider/equipment selection. The technical cautions below remain; references to the old A$2,000 CRM or separately paid fit check are historical. No equipment purchase, deployment or changed Windows acceptance is authorised by this document.

13 September 2026 · Internal decision brief for Monday · Recommendation, not an accepted deployment change

**A Mac mini can be a professional choice, provided we choose it for a demonstrated workflow and fund its operation. Local PostgreSQL does not by itself establish better security or lower total cost.** Select the computer that performs Bud's work separately from the service that stores shared CRM records.

My recommendation is to keep the existing Windows delivery baseline through the fit check, offer a dedicated execution computer only when useful, and compare vendor-hosted CRM with a managed Linux deployment before choosing office-hosted CRM. A Mac becomes a good candidate if the agreed work can run entirely through its browser, approved APIs and accessible files. Sharing that Mac with production CRM is an optional trade-off, with additional isolation and recovery work.

The [revision 19 engagement](AUSTIN-ENGAGEMENT-2026-09-10.json) controls current proposed terms: A$4,500 Agent OS; separately approved A$2,000 CRM setup; existing care terms. This review does not replace its Windows requirement or include hardware, premium licences, a remote Windows executor or round-the-clock server management in those prices.

## What the evidence changes

The interview describes REI Cloud, bank CSV preparation, spreadsheet work, Google Drive and Windows File Explorer. It does not identify a required application that only runs on Windows. That makes a Mac workflow demonstration worthwhile, but does not establish that the files, accounts, spreadsheet behavior and approvals can all move. See the [workflow analysis](</Users/yoda/Downloads/Austin-Realty-Interview-2026-09-10/detailed-analysis.md:32>) and [observed desktop tools](</Users/yoda/Downloads/Austin-Realty-Interview-2026-09-10/detailed-analysis.md:229>).

The claim that Hermes is inherently more native on macOS needs correction: its current documentation lists Apple silicon macOS and native Windows 10/11 as Tier 1 platforms. This is upstream support, not comparative reliability evidence or acceptance of RealBud's selected version. Our source baseline is Hermes 0.20.3, with a separately listed 0.21.0 update candidate; rolling upstream documentation must not be treated as proof for either build. [Hermes platforms](https://hermes-agent.nousresearch.com/docs/getting-started/platform-support), [native Windows details](https://hermes-agent.nousresearch.com/docs/user-guide/windows-native), [source pin](../server/hermes-pin.ts:4), [update candidate](../server/hermes-releases.ts:14).

Twenty has an official ARM64 image, so Apple silicon is a credible hosting target. The inspected v2.39.5 deployment contains the application, background worker, PostgreSQL 16 and Redis, with persistent database and file storage. It is more than one database container. Image availability establishes compatibility to test, not an installed Austin service. [Official ARM64 image](https://hub.docker.com/layers/twentycrm/twenty/v2.39.5/images/sha256-919f85a9c344f97a42b154ee9e1ed5419a9feb4c25715c463285a77b153db9e5), [release compose](https://raw.githubusercontent.com/twentyhq/twenty/twenty/v2.39.5/packages/twenty-docker/docker-compose.yml).

## Choose the two locations independently

| Decision | Sensible options | Selection rule |
|---|---|---|
| Where Bud performs computer work | Existing Windows PC; dedicated Windows PC; dedicated Mac | Use the actual apps, accounts, files and human sign-in/review path. A dedicated device can avoid interrupting Kevin's mouse and keyboard, but needs its own authenticated sessions and accessible source files. |
| Where the optional CRM runs | Twenty Cloud; Linux server with contracted application management; office Mac or Linux server | Use required permissions, availability, data location, recovery, support ownership and total cost. Windows staff can use a web CRM regardless of its server OS. |

For each workflow, use a supported API or validated file transformation when it supplies the required evidence and result; use supervised computer interaction where the application requires it. This is an execution choice behind RealBud's permissions and review, not a reason to fork Hermes. Keep Hermes upstream, test updates through its adapter and retain a working rollback path.

| Approach | Benefit for Austin | Main cost or constraint | Assessment |
|---|---|---|---|
| Windows Bud + vendor-hosted CRM | Preserves the agreed workstation/application path; CRM operation is less dependent on the office machine | Windows build acceptance; vendor seats, permissions, residency and service terms | Baseline to compare first if CRM is approved |
| Dedicated Mac Bud + vendor-hosted CRM | Gives Bud its own workspace; CRM can remain available while Bud is updated | Prove every required workflow on Mac and how Windows staff review work or complete private sign-in | Good optional alternative after a successful fit check |
| Local Bud + managed Linux CRM | Separates automation from shared records and avoids office power/login dependence for CRM | Someone must explicitly own Twenty, database, backup, restore and application updates; a managed VPS may cover only infrastructure | Strong self-hosting alternative if we price application operations |
| Mac Bud + local Twenty | Customer-controlled hardware and storage; can reuse a Mac already justified for Bud | Shared failure/resource exposure, office connectivity, Mac/Docker startup, off-site backup and replacement support | Deliberate local-hosting option, not the default security or savings claim |

A dedicated Linux office server is another local CRM option if macOS computer interaction is not needed on that machine. Docker Engine on Debian/Ubuntu starts at system boot by default; Docker Desktop on Mac adds a Linux VM and normally starts after a user signs in. This makes Linux worth comparing for a server-only role. [Linux service behavior](https://docs.docker.com/engine/install/linux-postinstall/), [Docker Desktop networking](https://docs.docker.com/desktop/features/networking/), [Desktop startup settings](https://docs.docker.com/desktop/settings-and-maintenance/settings/).

Mac coordinator plus remote Windows worker is a possible later topology. Upstream Cua documents Windows remote access, including an interactive-session daemon; a plain SSH process is insufficient for seeing the user's desktop. RealBud still needs device enrollment, authenticated transport, session-bound grants, ownership, disconnect reconciliation and acknowledged Stop. A Windows VM on Apple silicon also needs its own application, licensing and architecture acceptance. Neither is a shortcut already delivered by this repository. [Cua Windows remote guide](https://cua.ai/docs/how-to-guides/driver/windows-ssh), [existing Windows architecture requirement](AUSTIN-ENGAGEMENT-2026-09-10.json).

Before adding CRM at all, confirm the company relationship/pipeline problem that the existing systems fail to solve. REI remains the financial record. RealBud's thin property index and work evidence must not grow into a second rent-roll register.

## What RealBud currently supports

The inspected source launches the computer helper on RealBud's own host. Its private broker and app server bind to loopback, and the app uses local per-boot authentication. Opening these ports to the LAN would not supply staff authentication or remote-device authority. Hosting Bud on a Mac therefore does not currently let the Windows PCs use it as a shared, authenticated office agent. [Local helper](../electron/cua.mjs:117), [broker](../electron/cua-control.mjs:33), [server](../server/index.ts:4314), [local authentication](../server/session-auth.ts:5).

Startup and durable run recovery exist, but the inspected app has no demonstrated unattended service lifecycle: the server-child exit handler records exit without restarting it, Windows quits when all app windows close, and scheduled work runs inside the server process. The portal schedule currently queues attended work. Buying an always-powered machine does not close these gaps. [Child lifecycle](../electron/main.mjs:191), [window close](../electron/main.mjs:510), [scheduler](../server/routines.ts:440), [attended dispatch](../server/index.ts:1771).

No Twenty deployment/integration was found in the inspected implementation. Private staff DMs and per-person connector ownership also remain separate product work; upstream multi-user capability is not RealBud acceptance. Use the [scope and routine gaps](REALBUD-SCOPE-AND-ROUTINES-2026-09-13.md) and [staff-session design](REALBUD-STAFF-SESSIONS-2026-09-13.md) for those build requirements.

## Conditions for a professionally operated local service

These are proposed design and acceptance requirements, not claims about an installed system.

- **Separate administrative authority.** Bud gets only the CRM account/API permissions its accepted job needs. It must not have host administration, Docker-daemon access, production database volumes, backup credentials or recovery keys. Staff receive named accounts with appropriate roles. Containers alone do not justify giving a broadly capable host agent access to the business database. A separate CRM host reduces this coupling.
- **Define the access and data paths.** Provide authenticated encrypted access for Windows browsers and any agreed remote staff. Keep database and management interfaces private. Document what approved records go to model providers, email, connectors and off-site backup. Local storage does not establish local-only AI processing.
- **Prove recovery after actual interruption.** Test power loss, reboot, locked/logged-out desktop, helper crash, internet outage and upgrade. Docker Desktop's sign-in startup and Time Machine VM inclusion are disabled by default. FileVault also prevents automatic Mac login; retain disk protection and agree a supported recovery process rather than assuming power restoration restores the GUI. [Docker settings](https://docs.docker.com/desktop/settings-and-maintenance/settings/), [Apple login behavior](https://support.apple.com/en-au/102316).
- **Restore the complete service.** Back up the database, uploaded files, configuration and securely held encryption keys; keep encrypted off-site copies under separate access. Restore onto a different machine and record the result. Twenty's encryption key is needed to recover stored secrets, and its updates include database migrations, so restoring an older container alone is insufficient. [Twenty setup](https://docs.twenty.com/developers/self-host/capabilities/setup), [backup guidance](https://docs.twenty.com/developers/self-host/capabilities/docker-compose), [upgrade guide](https://docs.twenty.com/developers/self-host/capabilities/upgrade-guide).
- **Name the service owner and limits.** Assign patching, monitoring, backup-failure response, disk capacity, hardware replacement and recovery. Agree service hours, maximum tolerable data loss and restoration time. Measure memory/disk use during concurrent CRM imports and Bud jobs. The vendor minimum RAM is not an Austin capacity guarantee.

Twenty's free self-hosted edition includes core Pro functionality; SSO, row-level permissions and audit logs require paid Organization licensing. Its cloud licence does not transfer to self-hosting. Match the permissions requirement to an actual quote before promising a more secure CRM. Docker Desktop licensing eligibility also needs checking against Austin's business size/revenue. [Twenty billing](https://docs.twenty.com/user-guide/billing/how-tos/billing-faq), [Docker terms summary](https://docs.docker.com/desktop/setup/install/mac-install/).

## Offer hardware transparently and compare full cost

Offering a customer-owned Mac at verified retail or supplier-invoice cost is reasonable. Separate its exact specification, GST treatment, stock, delivery and warranty from provisioning, software licences, backup, support and replacement arrangements. Do not use the old A$1,500 hardware or A$450 setup allowances as current supplier quotes or promises of full server management.

Apple's current announcement gives a starting Mac mini RRP of A$1,449 including GST, with the new models available from 22 September. That is a starting configuration and announcement date, not a quote for the chosen memory/storage or a delivery promise for next week. Confirm stock and exact SKU before offering it. [Apple Australia announcement](https://www.apple.com/au/newsroom/2026/08/apple-unveils-a-more-powerful-mac-mini-featuring-the-all-new-m6-and-m5-pro/).

Compare 36 months on the same service scope:

| Local hosting cost | Hosted alternative cost |
|---|---|
| Hardware allocation + provisioning + any UPS/backup hardware + power + off-site storage + applicable licences + maintenance + recovery/replacement allowance | Migration/setup + seats or infrastructure + required application/database management + backup/recovery charges + applicable licences |

If the Mac is already justified for Bud, allocate only incremental CRM hardware cost; do not charge the whole machine twice. Conversely, do not treat maintenance hours as free. Keep common RealBud fees and model usage outside the hosting comparison. Local PostgreSQL does not remove model/API costs.

Obtain comparable quotes for three staff and the selected security features. Cloud data location, restore terms and export/exit provisions still need confirmation. For a VPS, distinguish infrastructure management from application management. The existing A$149 CRM care fee and old A$60/month hosting allowance must not silently absorb new service obligations.

## Next decision and acceptance

1. Map each of the two core workflows to its actual app, files, account, operator and reviewer. Confirm whether anything truly requires Windows. For a Mac option, demonstrate how Kevin reviews results and performs private sign-in from the agreed work arrangement.
2. Run the representative ANZ reference and expected-bill cases on the candidate device, including uncertain data, denied access, correction, Stop and recovery. A Mac demonstration is labelled Mac evidence; retain Windows acceptance unless Austin explicitly accepts a scope revision.
3. If CRM proceeds, compare three equivalent hosting/service quotes and the required roles. Select an owner and recovery target before deciding where PostgreSQL lives.
4. Rehearse cold boot, missed schedule, duplicate/retried work, backup restoration and a version update on the selected deployment. Record exact artifact/version, device, result and remaining limitations.
5. Freeze the agreed topology and commercial responsibilities, then build the scoped gaps. Revisit separation when more staff, multiple execution devices, sensitive record restrictions or availability needs outgrow the first appliance.

Suggested Monday wording:

> “RealBud works alongside your existing systems. We will test the work on your Windows setup first. If a dedicated computer improves reliability, we can supply a Windows device or Mac mini at an agreed retail cost. CRM is optional: we will compare managed hosting with local hosting, including permissions, backups and support, before recommending where it should run.”

This review used the current repository, discovery material and official platform/vendor documentation. It did not install CRM, test either customer device, activate schedules, access Austin accounts or establish live-office readiness.
