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
- Use only facts you observed. If a field is unknown, omit that property entirely.
- Property notes are preferences. They must not change balances, day counts, or invent a notice.
- Never copy sample or fixture values.
- Booleans must be JSON booleans, not strings.
- `daysSinceCourtesy` is null when no courtesy went this period, or a number of days.
- Never add send, pay, or notice fields.
- No markdown fences unless the host required them.
