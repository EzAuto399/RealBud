# Austin — before and after workflow pack

11 September 2026. Before maps summarize draft interview findings. After maps describe the proposed delivery; real-office acceptance remains open. REI owns the financial record. Kevin retains financial review and sign-in authority.

## Bills After

```mermaid
%% Austin proposal, 11 September 2026. Before: draft interview findings. After: proposed delivery; acceptance remains open.
flowchart TD
 A[Approved expected-bill register] --> B[Daily check of agreed sources]
 B --> C{Invoice received?}
 C -->|No| D{Arrival window passed?}
 D -->|No| E[Keep watching expected occurrence]
 E --> B
 D -->|Yes| F[Missing-bill follow-up with owner and next check]
 C -->|Yes| G[Link invoice and flag duplicates or uncertainty]
 G --> H[Kevin verifies property amount and due date]
 H --> I[Agreed due-date reminder]
 I --> J[Staff arranges payment]
 J --> K{Payment evidence confirmed in REI?}
 K -->|No| L[Keep payment-arranged follow-up open]
 K -->|Yes| M[Record verified completion]
```

## Bills Before

```mermaid
%% Austin proposal, 11 September 2026. Before: draft interview findings. After: proposed delivery; acceptance remains open.
flowchart TD
 A[Expected regular bill] --> B[Remember arrival and due dates]
 C[Email or attached invoice arrives] --> D[Find property and bill details]
 B --> E[Manually check whether bill arrived]
 E -->|Missing| F[Chase issuer]
 E -->|Received| D
 D --> G[Arrange review or payment]
 G --> H[Check actual payment confirmation in REI]
```

## Crm After

```mermaid
%% Austin proposal, 11 September 2026. Before: draft interview findings. After: proposed delivery; acceptance remains open.
flowchart TD
 A[Selected email or CRM record] --> B[Bud reads approved context]
 B --> C[Propose contact enquiry or follow-up]
 C --> D[Team reviews exact record and changes]
 D --> E{Approved and still current?}
 E -->|No| F[Hold for correction or fresh review]
 E -->|Yes| G[Save through scoped Twenty connection]
 G --> H{Result known?}
 H -->|No| I[Inspect operation and record before retry]
 H -->|Yes| J[Read back result and show receipt]
 J --> K[Shared owner and next action visible]
```

## Crm Before

```mermaid
%% Austin proposal, 11 September 2026. Before: draft interview findings. After: proposed delivery; acceptance remains open.
flowchart TD
 A[Enquiry in email] --> B[Search contacts and notes]
 B --> C[Copy contact and property details]
 C --> D[Record who should follow up]
 D --> E[Manually check the next action]
```

## Inbox After

```mermaid
%% Austin proposal, 11 September 2026. Before: draft interview findings. After: proposed delivery; acceptance remains open.
flowchart TD
 A[Agreed daily mailbox review] --> B[Read permitted coverage window]
 B --> C{Coverage complete?}
 C -->|No| D[Retain checkpoint and show missing coverage]
 C -->|Yes| E[Link existing threads and work items]
 D --> E
 E --> F[Suggest category property owner and evidence-based date]
 F --> G[Kevin reviews uncertainty and priorities]
 G --> H[Daily work list with source links]
 H --> I[Preserve human edits and completion]
 I --> J[New material reply updates existing item]
 H --> K[Weekly shared summary]
```

## Inbox Before

```mermaid
%% Austin proposal, 11 September 2026. Before: draft interview findings. After: proposed delivery; acceptance remains open.
flowchart TD
 A[New emails and replies] --> B[Read and revisit threads]
 B --> C[Identify property and next action]
 C --> D[Copy notes to a work list]
 D --> E[Choose owner and priority]
 E --> F[Remember follow-up and reopen source]
```

## Payments After

```mermaid
%% Austin proposal, 11 September 2026. Before: draft interview findings. After: proposed delivery; acceptance remains open.
flowchart TD
 A[Approved daily or anchored two-day schedule] --> B{Device and account ready?}
 B -->|No| H[Save hold and alert Kevin]
 H --> I[Kevin signs in and presses Continue]
 I --> J{Correct account verified?}
 J -->|No| H
 J -->|Yes| K[Kevin selects one reviewed next step]
 K --> C
 B -->|Yes| C[Download agreed bank export]
 C --> D[Preserve original and coverage receipt]
 D --> E[Propose approved property references]
 E --> F[Flag ambiguity and possible overlap]
 F --> G[Kevin reviews all reference decisions]
 G --> L[Export checked copy with original retained]
 L --> M[Inspect REI preview and totals]
 M --> N[Staff approves final import and confirms result]
 C -. Known temporary failure only .-> R[At most two bounded retries]
 R --> C
 C -. Unknown result .-> U[Hold and inspect receipt before retry]
```

## Payments Before

```mermaid
%% Austin proposal, 11 September 2026. Before: draft interview findings. After: proposed delivery; acceptance remains open.
flowchart TD
 A[Bank export becomes available] --> B[Kevin downloads CSV or spreadsheet]
 B --> C[Look up unclear payers and properties]
 C --> D[Edit payment references manually]
 D --> E[Review and import in REI]
 E --> F[REI recognition and reconciliation]
 F --> G{Unmatched or unclear?}
 G -->|Yes| C
 G -->|No| H[Staff confirms result]
```

## Platform And Hardware

```mermaid
%% Austin proposal, 11 September 2026. Before: draft interview findings. After: proposed delivery; acceptance remains open.
flowchart LR
 U[Kevin and team] --> B[RealBud on Windows]
 B --> H[Hermes adapter]
 H --> C[Cua controlled website and native app work]
 B --> R[REI review and final financial record]
 B --> A[Scoped CRM connection]
 A --> T[Twenty CRM]
 T --> X{Choose one hosting route}
 X --> M[Hosted infrastructure]
 X --> N[Optional Mac mini]
 M --> O[Off-site backup and tested restore]
 N --> O
 B --> D[Shared saved approvals and phone alerts]
```
