---
name: morning-arrears
description: Return structured ledger facts for the RealBud morning check. Draft only.
---

When RealBud asks for a morning check, reply with **JSON only** — an array of:

```json
[{
  "propertyId": "prop-oak",
  "daysSinceDue": 3,
  "rentLanded": false,
  "levyPaid": false,
  "daysSinceCourtesy": null
}]
```

Rules:
- Use only facts from the prompt. If unknown, copy the fixture values given.
- `daysSinceCourtesy` is null when no courtesy went this period, or a number of days.
- Never add send, pay, or notice fields.
- No markdown fences unless the host required them.
