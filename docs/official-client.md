# Official CyberSource transport

`OfficialClientTransport` is tested against `cybersource-rest-client@0.0.84`.
The official package is supplied and configured by the application; it is not a
runtime dependency of ICC SDK. Use separate `ApiClient` instances for tenants.

```js
import CyberSource from 'cybersource-rest-client';
import { CommerceClient, OfficialClientTransport } from '@gupta799/icc-sdk';

// Obtain the approved sandbox JWT/MLE configuration from your onboarding team.
// Read keys from a secret manager. Do not put credentials into SDK call headers.
// Disable upstream logging: decrypted bodies and encryption payloads can reach debug logs.
approvedConfiguration.logConfiguration = { enableLog: false };
const apiClient = new CyberSource.ApiClient();
const checkout = new CyberSource.ACPCheckoutApi(approvedConfiguration, apiClient);
apiClient.timeout = 20_000;
const transport = new OfficialClientTransport({
  createCheckoutSession: checkout,
  getCheckoutSession: checkout,
  updateCheckoutSession: checkout,
  completeCheckout: checkout,
  cancelCheckout: checkout,
}, { timeoutMs: 30_000 });
const client = new CommerceClient({ transport });
```

Map every operation you intend to use. A missing API instance or method raises
`TransportConfigurationError` before the operation is invoked. The adapter maps
contract path arguments, optional headers, query values and body parameters to
the installed SDK's callback method signatures. Call headers must be documented
parameters for that operation; configure any other provider headers on the
caller-owned official client.

The adapter preserves original decrypted JSON from the official callback's
response text because generated SDK response models drop unknown fields. It
also retains HTTP response headers. It does not return the official response's
`req` object, which can contain credentials and payment data. HTTP error response
JSON is decoded even when the official callback's data argument is null.

The default callback wait is 30 seconds; configure `timeoutMs` if necessary.
This deadline bounds the caller's wait and does not cancel an in-flight request.
A timeout, missing HTTP status or transport failure leaves mutations uncertain.
Reconcile with authoritative merchant/PSP records before any new submission.
`AbortSignal` is checked before dispatch; in-flight cancellation is not provided.

## Verified compatibility and limits

Offline tests instantiate all actual official API classes used by ICC SDK and
check argument and route mapping for all 37 operations. Additional tests run the
actual official HTTP client with a substituted Axios network boundary for
success, HTTP errors, and connection errors. Test fixtures use fake HTTP
signature credentials and disable request MLE only to exercise that boundary.
They do not verify live JWT, encryption, participant entitlements or sandbox
business behavior.

The pinned official release starts request encryption in a detached
promise without an error handler in generated methods. A request-encryption
failure can produce an unhandled rejection before any callback. An isolated
regression test confirms this by injecting a rejected encryption promise into
the installed SDK; it does not exercise cryptographic correctness. ICC SDK's wait
deadline cannot prevent that process-level failure. Validate certificates and
JWT/MLE configuration in the sandbox, and require a supported upstream fix (or a
reviewed application-owned patch) before production use. No authenticated Visa
sandbox request has been run for this project.
