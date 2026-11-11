# Changelog

## 0.3.0

- Add PurchasingAgent: quote preparation, trusted per-purchase policies, fresh approval/authentication, ephemeral credentials, merchant checkout and authoritative reconciliation.
- Add credential-free durable PostgresPurchaseStore with versioned execution claims, immutable account/customer/quote bindings and separate confirmation state.
- Add backend-bound model tools for prepare, execute, status and reconciliation; model arguments cannot supply identity, policy, approval or credentials.
- Add ICCMerchantConnector and an opt-in local commerce simulator with pricing, inventory, single-use synthetic credentials and response-loss recovery.
- Add handwritten Direct VIC v2 client, verified-certificate mTLS transport and payment-provider bridge with mandatory application signing/authentication/JWE/JWS hooks.
- Add runnable purchasing-agent example, real HTTP/mTLS integration tests, PostgreSQL restart recovery tests, and packed-consumer verification of the agent workflow.

Scope now includes agent orchestration and a separate Direct VIC integration boundary; the existing ICC API and legacy checkout helpers remain compatible. No authenticated Visa sandbox request or live cryptographic interoperability has been verified.

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
