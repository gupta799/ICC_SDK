# Legacy ICC checkout integration and recovery

ICC SDK is an independent personal project for prototypes and sandbox integrations. This guide describes the legacy completeApprovedCheckout helper. The new PurchasingAgent workflow and separate Direct VIC module are described in agents.md and direct-vic.md. The legacy helper does not implement TAP verification, issuer authorization, capture, refunds, or chargeback handling. Choose the integrations appropriate to the merchant's role.

## Boundaries and tenant identity

Configure merchant scopes on the backend and bind each scope to its own approved API configuration, PSP credentials, and database authorization. A scope is an SDK storage namespace, not proof of Visa entitlement. Do not let an agent or HTTP request select an arbitrary scope, official client, or reconciliation account. Use a dedicated official `ApiClient` per tenant and the same attempt table across all workers serving that merchant. Changing the scope, deleting records, or using independently writable stores bypasses the completion fence.

`checkoutIdempotencyKey(scope, attemptId)` deterministically hashes a versioned scope/attempt tuple into a 64-character key. Keep scope and attempt ID stable and use the same function for merchant/PSP lookups. Do not mix low-level completion submissions with workflow submissions for the same session; only the workflow claims the durable session fence.

A claim reserves both attempt and session. The SDK does not automatically retry or release a claimed session, including after HTTP errors or local timeouts. To recover, reconcile using authoritative records. A lookup with no order may be racing an in-flight request. If operational recovery requires another purchase, establish the original transaction's final state and use a separately approved new checkout session through the merchant's process.

## Checkout approval and validation

The workflow requires a matching session in `ready_for_payment`, a currency code, exactly one nonnegative safe-integer grand total, and a compatible payment provider if the session names one. The approval callback receives a detached provider cart with a completion buyer override applied; it must return literal `true`. It never receives the separately supplied payment payload, but provider response fields may themselves be sensitive. Render only fields needed for the approval decision and treat untrusted provider text as data.

Revalidation compares financial and fulfillment fields, buyer, state, and available payment/fulfillment options. The server remains responsible for atomically enforcing the approved quote. The SDK cannot add an undocumented quote-lock or amount precondition to ICC. Use the applicable merchant checkout server's concurrency controls and verify them in the sandbox.

A completed response must match the session, financial and fulfillment fingerprint and contain a nonempty order ID. Optional provider enrichment of purchase fields can fail this conservative check. An uncertain response stays unresolved; investigate it with approved fixtures rather than disabling validation to force a completed state.

## Errors and caller actions

| Error/result | Meaning | Action |
| --- | --- | --- |
| `ValidationError` | Local request/header validation failed before transport | Correct input |
| `TransportConfigurationError` | Adapter proves an API mapping/configuration check failed before dispatch | Correct configuration |
| `CheckoutNotReadyError` | Session is not usable for this purchase | Refresh the checkout and inspect merchant state |
| `CheckoutApprovalDeclinedError` | Approval callback did not return true | Stop; obtain new approval only through the application's consent flow |
| `CartChangedError` | Checkout changed during approval | Show the updated purchase and obtain fresh approval |
| `AttemptConflictError` | Attempt ID already binds another session/payment | Investigate ID reuse; do not change IDs to bypass an unresolved session |
| `UnknownOutcomeError` | Submission/persistence cannot establish a completed order | Reconcile; preserve the claim |
| `ResponseValidationError` | HTTP success did not match the pinned response schema | Retain operation/status metadata and obtain approved fixtures; a write may have occurred |
| `ApiError` | HTTP error, or a read transport failure with status 0 | Classify by status/reason; no automatic retry guarantee |
| `FeedFailedError` | Rejected ingestion records or failed requested syndication | Inspect the feed through authorized tooling; repair before a new submission |
| `action_required` / `accepted` | Acknowledgment or further action required | Follow operation-specific lifecycle; not a completed payment |
| `unverified` | Credential response variant is ambiguous | Verify applicable contract and fixture before consumption |

The low-level client exposes response validation failures directly. The approved checkout workflow records post-claim failures as unknown regardless of the transport/error class, because its fence must remain conservative. Signals stop reads and pre-dispatch work; cancellation/timeout after dispatch does not establish that a write failed. Official callback timeout bounds waiting but does not cancel the underlying network request.

## Personal and payment data

Payment and quote bindings use hashes; supplied payment payloads are not stored in attempts. Completed provider responses preserve unknown fields and are persisted as JSONB. They may contain personal or payment-sensitive material. Apply access controls, encryption, retention, and redaction to the database, backups, logs, approval UI and reconciliation adapters. Avoid logging SQL values or complete error objects from upstream clients.

Set `logConfiguration.enableLog: false` on the official SDK configuration. Its debug paths can log decrypted bodies and encryption payloads; an SDK masking list is not a guarantee for unknown fields. The ICC evidence sink receives only operation/status/outcome metadata; delivery is best effort. It is not a durable dispute-evidence store.

## Before enabling real payments

Validate the exact onboarded merchant configuration in an authenticated sandbox: JWT and mutual requirements, mandatory request/response MLE, approved request/response fixtures, pending authentication, cancellation, rejection, response loss, and merchant/PSP reconciliation. Resolve the upstream detached encryption rejection documented in the official-client guide. Exercise server quote enforcement, order/capture mapping and key rotation. The current local tests cover neither live Visa behavior nor certification. Select the distribution license and complete package ownership/release checks before public distribution.

## Upgrade from 0.1

Version 0.2 adds strict responses, session-wide fences and scope-derived upstream keys. Custom `AttemptStore` implementations must atomically fence sessions as well as attempt IDs, reject changed bindings, and preserve the first completion. In-flight attempts from other implementations/key formats require reconciliation with their original keys before migration. Do not re-hash and resend an unresolved older attempt. No automatic database migration or payment retry is performed by this upgrade.
