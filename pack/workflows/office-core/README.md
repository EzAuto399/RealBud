# Real estate office core — revision 1

`realbud-office-core-v1.json` is a self-contained portable pack for a private agency workspace. It contains three business workflows and four preparation plans: bank references, invoice intake, bill exceptions, and morning mail priorities. It contains instruction-only skill guidance and its license, no accounts, credentials, customer records, machine paths, approved plans or enabled schedules.

The pack has independent `office-core` identity and `wf-office-core-*` plan IDs. It does not modify or replace published Austin pack bytes. Install through reviewed pack preview/import, explicitly select it in Agency workflow setup, then approve each required plan and the current setup. Importing both packs does not choose either one automatically; code-owned role bindings use the selected pack.

Agency identity, timezone, private account scope and property mappings come from reviewed host settings. No customer or named staff member is preselected. Default routing is an internal review proposal subject to agency plan review. Host validation remains authoritative for original-file preservation, source coverage, exact output identity, duplicate/conflicting records and permitted actions.

The bank preparation contract currently supports the ANZ adapter. This does not establish that an agency banks with ANZ, that its export layout matches, or that REI or another accounting system accepted an import. Other bank brands need an admitted adapter and source contract. The local deterministic file review can expose separate supported formats; this plan must not widen its own bank contract.

Source connectors, real model runs, acceptance of invoice evidence, recurrence rules, external delivery, payments and accounting imports retain their separate host controls. The source text and skill examples do not grant any of these permissions.
