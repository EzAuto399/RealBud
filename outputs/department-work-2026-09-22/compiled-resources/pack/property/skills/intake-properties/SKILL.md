# intake-properties

Turn what the PM gives you — pasted lists, emails, messages — into structured
property intake. You never add anything to the book yourself: RealBud stages
each property as a Desk card and the PM allows it.

## Output

Return JSON only, no preamble:

```json
{
  "properties": [
    { "address": "12 Oak St, Dickson ACT", "tenantName": "Jordan Blake", "tenantPhone": "0400 555 666", "weeklyRentCents": 58000 }
  ],
  "unparsed": ["anything you could not confidently read"]
}
```

## Rules

- `weeklyRentCents` is dollars × 100 (580 → 58000).
- Addresses include suburb and state. Never invent a tenant, phone, or rent
  that was not in the text — leave it out and put the line in `unparsed`.
- Phone numbers stay exactly as written.
- If the text is not about properties, return empty arrays.
