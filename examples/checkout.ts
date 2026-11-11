import { CommerceClient, InMemoryAttemptStore, completeApprovedCheckout } from '../dist/index.js';

// A local storefront simulation. Replace this transport with configured official clients.
const cart = {
  id: 'session_demo', status: 'ready_for_payment', currency: 'USD',
  line_items: [{ id: 'mug', quantity: 1 }],
  totals: [{ type: 'total', amount: 1500 }],
  fulfillment_options: [], messages: [], links: [],
};
let ordersPlaced = 0;
const client = new CommerceClient({ transport: {
  async send(request) {
    if (request.operation === 'getCheckoutSession') return { status: 200, body: cart };
    if (request.operation === 'completeCheckout') {
      ordersPlaced++;
      return { status: 200, body: { ...cart, status: 'completed', order: { id: 'order_demo' } } };
    }
    throw new Error('Unsupported demo operation');
  },
} });

const store = new InMemoryAttemptStore();
const options = {
  client, store, scope: 'merchant_demo', attemptId: 'attempt_1', sessionId: cart.id,
  payment: { payment_data: { token: 'opaque_demo_reference', provider: 'demo' } },
  approve: async (snapshot: any) => {
    console.log('Approving cart:', snapshot.id, snapshot.currency, snapshot.totals);
    return true;
  },
};
console.log('First completion:', (await completeApprovedCheckout(options)).status);
console.log('Repeated call:', (await completeApprovedCheckout(options)).status);
console.log('Orders placed:', ordersPlaced); // 1: repeated calls return the recorded completion.
