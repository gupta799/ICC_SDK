import { CommerceClient } from '../dist/index.js';
// Local merchant registration + session creation illustration. No payments or network calls.
const client = new CommerceClient({ transport: { async send(request) {
  console.log(request.method, request.path);
  if (request.operation === 'registerMerchant') return { status: 201, body: {
    id: 'merchant_demo', merchantName: 'Northstar Demo', merchantUrl: 'https://northstar.example',
    indicator: 'ACG', isActive: true, createdAt: '2026-11-11T00:00:00Z', updatedAt: '2026-11-11T00:00:00Z',
  } };
  return { status: 201, body: { id: 'session_demo', status: 'not_ready_for_payment', currency: 'USD',
    line_items: [], fulfillment_options: [], totals: [], messages: [], links: [] } };
} } });
console.log(await client.merchant.register({ merchantName: 'Northstar Demo', merchantUrl: 'https://northstar.example', indicator: 'ACG' }));
console.log(await client.checkout.acp.create({ items: [{ id: 'sku_mug', quantity: 1 }] }));
