# Post-chat-performance workflow regression

All five scripts passed: **49 workflow assertion groups and16 second-office checks**. This rerun used the renderer rebuilt after the ChatView performance fix. The later long-chat button-spacing correction is separately verified by the platform agent; these short-history workflows were not rerun for that isolated spacing change.

See `runners.json` and each workflow receipt for exact source hashes, counts, timing and limits. Existing `final-renderer/` receipts are preserved. No owned fixture services or browser jobs remain. No PostgreSQL, packaged Electron or live integrations ran in this packet.
