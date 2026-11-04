// Amazon.de hand-off links: a product page, or Amazon's documented add-to-cart form URL.
// Checked Oct 31: /gp/aws/cart/add.html is recognised (signed-out users go to sign-in, then the cart).
// The user always reviews and pays on Amazon.de themselves.

const ASIN = /^[A-Z0-9]{10}$/;

export function amazonProductUrl(asin: string): string {
  if (!ASIN.test(asin)) throw new Error('not an ASIN');
  return `https://www.amazon.de/dp/${asin}`;
}

export function amazonAddToCartUrl(asin: string, quantity = 1): string {
  if (!ASIN.test(asin)) throw new Error('not an ASIN');
  const q = new URLSearchParams({ 'ASIN.1': asin, 'Quantity.1': String(Math.max(1, Math.min(10, Math.round(quantity)))) });
  return `https://www.amazon.de/gp/aws/cart/add.html?${q}`;
}
