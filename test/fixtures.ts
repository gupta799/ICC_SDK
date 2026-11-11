import type { CheckoutCart, CompletedCheckout } from '../dist/index.js';

/** Contract-shaped local fixture; no authenticated Visa response is implied. */
export const cart: CheckoutCart = {
  id: 's1', status: 'ready_for_payment', currency: 'USD',
  line_items: [{ id: 'sku', item: { id: 'sku', name: 'Mug', quantity: 1 }, total: 1000 }],
  totals: [{ type: 'total', display_text: 'Total', amount: 1000 }],
  buyer: { first_name: 'Test', email: 'test@example.com' },
  fulfillment_option_id: 'digital', fulfillment_options: [], messages: [], links: [],
};
export const order: CompletedCheckout = { ...cart, status: 'completed', buyer: cart.buyer!,
  fulfillment_option_id: 'digital', order: { id: 'order-1', checkout_session_id: 's1' } };
export const payment = { payment_data: { token: 'opaque', provider: 'test' } };
