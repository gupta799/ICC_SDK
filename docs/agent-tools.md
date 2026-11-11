# Tools for purchasing agents

`createPurchasingTools` exposes framework-neutral descriptors for a function-calling host. It does not start an MCP server or depend on an LLM framework. Each descriptor provides `name`, `description`, `inputSchema`, and an asynchronous `execute` function.

Configure the `PurchasingAgent` with merchant connectors, a payment authorization provider, and durable storage first. Then bind tools to an authenticated customer on the backend:

```ts
import { createPurchasingTools } from '@gupta799/icc-sdk';

const tools = createPurchasingTools({
  agent,
  scope: authenticatedSession.tenantId,
  customerId: authenticatedSession.customerId,
  policy: purchasePolicyFromYourBackend,
  approve: request => approvalUI.confirmPurchase(request),
  authenticate: request => approvedAuthenticationService.authenticate(request),
});
```

The application adapts `inputSchema` to its host's tool declaration format and calls `execute(parsedArguments, { signal })` for a selected tool. Use only the returned tool list to resolve model-selected tool names.

| Tool | Model arguments | Behavior |
| --- | --- | --- |
| `prepare_purchase` | `purchaseId`, `merchantId`, `items: [{ id, quantity }]` | Prepare a quote under the bound policy; does not submit payment |
| `execute_purchase` | `purchaseId` | Request execution with backend approval and authentication callbacks |
| `get_purchase` | `purchaseId` | Read this customer's normalized purchase status |
| `reconcile_purchase` | `purchaseId` | Read authoritative merchant records for an uncertain purchase; never resubmit payment |

Model arguments cannot supply or override the tenant, customer, policy, approval callback, authentication evidence, credential, or payment provider. Runtime validation rejects unexpected properties even if the tool host does not enforce the JSON schema. The engine checks customer ownership for every operation.

Policies are copied when the factory is created and again for each prepare call. Recreate tools when the authenticated session or approved policy changes. A policy's spending limit is per purchase; this is not an aggregate account budget or a substitute for provider-side controls. Duplicate purchase IDs and quote reservations remain governed by the shared purchase store.

An execution request from the model is not consumer approval. The trusted application callback must obtain it and return literal `true`, and the authenticator must integrate the approved consumer authentication service. Handle `authentication_required` through the application's trusted UI. Tool results omit authentication action IDs, provider references, raw provider payloads, and arbitrary error details. The backend can inspect `agent.get` separately to continue an approved challenge flow.

Success results have `{ ok: true, purchase }`; failures have `{ ok: false, error: { code } }`. Error codes are fixed values (`INVALID_ARGUMENTS`, `POLICY_REJECTED`, `PURCHASE_CONFLICT`, `PURCHASE_NOT_FOUND`, `PURCHASE_FAILED`). Do not append upstream exception messages or payment data to those results. Quotes, titles, and merchant text remain external data; render and present them accordingly.

The tool output is not proof of issuer approval or capture. Inspect the separate order `paymentStatus`, and confirm outcomes using the merchant and payment provider integration. Live Visa access, onboarding, authentication, and approved credentials remain prerequisites for the real adapters. The simulation is an explicit local mode and submits no real payments.
