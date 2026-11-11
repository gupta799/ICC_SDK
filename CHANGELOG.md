# Changelog

## 0.2.0

- Add durable PostgreSQL attempt/session fencing and monotonic completed records.
- Validate checkout readiness, response schemas and completed purchase identity; return the persisted winner after reconciliation races.
- Derive upstream idempotency keys from trusted merchant scope and attempt ID; support checkout cancellation signals.
- Check all 37 operation mappings against the real CyberSource 0.0.84 package; retain raw decrypted responses and bound callback waits.
- Bound catalog polling and callback waits; reject invalid lifecycle states and rejected feed records.
- Verify clean package installation, declarations and ESM runtime; add Node/PostgreSQL CI.
- Record actual contract generator input hashes and operation/path counts.

Breaking behavior: strict response validation is now the default; custom stores must also fence session IDs; workflow upstream keys now include scope. Reconcile older unresolved attempts with their original keys before upgrading. See docs/integration.md.

No authenticated Visa sandbox integration or certification is implied.
