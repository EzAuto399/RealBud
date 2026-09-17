# Square live / sandbox wiring

1. Create Square application (sandbox first) with Invoices + Orders + Customers.
2. Set gateway secrets:

```bash
fly secrets set \
  SQUARE_ACCESS_TOKEN=... \
  SQUARE_NOTIFICATION_URL=https://realbud-managed-gateway.fly.dev/v1/webhooks/payment \
  SQUARE_WEBHOOK_SIGNATURE_KEY=... \
  REALBUD_PAYMENT_MODE=sandbox \
  REALBUD_AUTHORIZE_COLLECTION=1 \
  -a realbud-managed-gateway
```

3. Map tenant → Square merchant/customer/location via operator code using `SquareBilling.map(...)`.
4. Close month with `squareDraftForPeriod` (see `square-live.ts`) after the customer accepts the usage statement digest.
5. Website `/account/invoices` opens local/hosted checkout; Square draft invoices are the tax-invoice path when Square is configured.
6. Promote to `REALBUD_PAYMENT_MODE=live` only after sandbox payment + webhook settlement proof.

Customer UI never shows private margin — only accepted retail AUD incl. GST.
