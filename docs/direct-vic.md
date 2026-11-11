# Direct VIC v2 provider

ICC SDK contains a separate handwritten Direct VIC client and a payment provider for the purchasing-agent workflow. This is independent software, unaffiliated with Visa and not endorsed, sponsored or certified by Visa. It has not executed an authenticated Visa sandbox request.

The implementation separates credential acquisition from merchant checkout. A Direct VIC response supplies payment material; it does not establish issuer approval, order creation or capture. The purchasing agent passes the verified credential to its configured merchant connector in backend memory.

## Client and transport

`VicClient` supports these Direct VIC v2 operations:

| Method | API | SDK method |
| --- | --- | --- |
| POST | `/vacp/v2/credentials-for-instruction` | `credentialsForInstruction` |
| POST | `/vacp/v2/instructions/{instructionId}/credentials` | `retrieveCredentials` |
| POST | `/vacp/v2/instructions/{instructionId}/confirmation` | `confirmInstruction` |
| PUT | `/vacp/v2/instructions/{instructionId}/cancel` | `cancelInstruction` |

`VicMtlsTransport` uses a dedicated Node HTTPS agent with client certificate/key, TLS 1.2 minimum and certificate/hostname verification enabled. Supply the proper CA bundle if your approved environment requires it. The transport bounds request/response sizes and total request time, does not follow redirects, and never retries writes. An HTTP timeout or failed connection does not prove the operation failed. The deployment's proxy routing, certificates, credentials, approved Visa environment and participant permissions remain deployment configuration.

```ts
import { readFileSync } from 'node:fs';
import { VicClient, VicMtlsTransport } from '@gupta799/icc-sdk';

const transport = new VicMtlsTransport({
  baseUrl: 'https://sandbox.api.visa.com',
  cert: readFileSync(process.env.VIC_CERT_FILE!),
  key: readFileSync(process.env.VIC_KEY_FILE!),
  timeoutMs: 30_000,
  // Supply basicAuth only if required by your onboarded VDP configuration.
});
const vic = new VicClient(transport);
// Use vic methods only in your trusted backend. Call transport.close() on shutdown.
```

The handwritten types and runtime checks cover the required request envelope, monetary strings, verification records, references, four routes and successful response boundaries. Unknown provider fields are retained by the low-level client. These types are not a claim to model every conditional business rule or every participant variant.

## Purchasing-agent payment provider

Construct `VicPaymentProvider` with the client plus four explicit application integrations:

- `merchantIdentity(quote)` maps your connector identity to its onboarded Visa merchant ID, name and URL.
- `buildCredentialsRequest(request)` produces the create-instruction request using the consumer's existing token reference, current approved authentication evidence, a bounded mandate, app/device context and any required fresh agent signature. The builder receives backend authentication evidence, never a model-generated authentication assertion.
- `verifyAndDecode(envelope, request)` performs JWE decryption if needed and JWS signature/claim verification with approved keys. It returns a merchant-compatible ephemeral credential, its transaction reference and expiry. Merely Base64-decoding a JWT does not satisfy this integration. The provider fails closed if this function is missing, rejects, returns an unrelated reference or returns an expired credential.
- `buildConfirmationRequest(request, reference)` creates the applicable post-purchase confirmation from authoritative merchant/PSP payment state, using fresh signature data where required.

The provider checks builder output against the immutable approved purchase: customer, mapped merchant identity, currency, exact transaction amount, mandate budget/expiry and stable references. Configure `currencyExponents` explicitly (for example `{ USD: 2, JPY: 0, KWD: 3 }`) so major-unit API amounts are compared to SDK minor-unit integers without floating-point rounding. Current provider orchestration supports one human-approved purchase and one mandate; subsequent credential retrieval and cancellation are exposed as separate low-level methods rather than automatic retries or autonomous recurring purchases.

The non-secret authorization reference encodes the instruction ID, original transaction reference and mandate ID. This permits confirmation after a process restart without persisting payment credentials. The generic purchasing store retains these identifiers and sanitized order data; it never stores the credential or consumer authentication evidence. Low-level `VicClient` results contain sensitive material, so do not log them or return them to an agent model.

`VicPaymentProvider.confirm` defers without any Visa call when the merchant reports payment status `unknown`. A completed order alone is insufficient evidence to report an approved payment. Reconciliation must obtain `authorized` or `captured` from the authoritative PSP/merchant before the provider can send an `APPROVED` confirmation. The canonical confirmation schema currently enumerates `APPROVED`, `DECLINED`, and `CANCELLED`, while workflow prose also mentions pending/error statuses. This implementation does not invent unsupported variants.

## Required onboarding and known discrepancies

The application must obtain the applicable Visa participant IDs, token reference, approved consumer authentication integration, mTLS credentials and signing/encryption keys. This package does not implement VTS PAN enrollment, a hosted Visa Payment Passkey UI, or TAP message verification. The `ConsumerAuthenticator` interface connects your approved backend authentication service to the agent workflow.

The published cancellation schema requires `assuranceData`, while its descriptive note questions that requirement. The client conservatively requires it pending an approved contract/fixture. Cancellation does not make an already-issued credential unusable. Confirm the existing credential's outcome before canceling as required by the applicable lifecycle; neither operation is retried automatically.

Sources: [VIC workflow](https://developer.visa.com/docs/visa-intelligent-commerce/workflows), [create-instruction schema](https://developer.visa.com/api-reference/visa-intelligent-commerce/post-vacp-v2-credentials-for-instruction.md), [confirmation schema](https://developer.visa.com/api-reference/visa-intelligent-commerce/post-vacp-v2-instructions-instructionid-confirmation.md), [cancellation schema](https://developer.visa.com/api-reference/visa-intelligent-commerce/put-vacp-v2-instructions-instructionid-cancel.md).

## Verification

Tests exercise all four client routes, response correlation, malformed requests and responses, exact payment bindings, mandatory credential verification and restart-safe confirmation references. Additional tests exchange real HTTPS requests with a local server requiring a freshly generated disposable test client certificate, reject an untrusted server CA, and enforce response-size/time bounds. Development tests require the OpenSSL executable. They generate CA/server/client identities in an operating-system temporary directory, load them into memory, and remove every temporary certificate/key file before the TLS tests start; no PEM keys are checked into the repository. These establish local transport and workflow behavior, not authenticated Visa connectivity or cryptographic compatibility with a live Visa payload.
