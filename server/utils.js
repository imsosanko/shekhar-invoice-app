// Shared business logic — used by the invoices route so totals are always
// computed server-side (never trust numbers the client sends).

const CURRENCY_META = {
  INR: { symbol: '₹', locale: 'en-IN', major: 'Rupees', minor: 'Paise' },
  USD: { symbol: '$', locale: 'en-US', major: 'US Dollars', minor: 'Cents' }
};

function curMeta(currency) {
  return CURRENCY_META[currency] || CURRENCY_META.INR;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * Computes subtotal / discounts / CGST / SGST / IGST / total tax / grand total
 * for a set of invoice line items, given the customer's state and the
 * business's settings (tax type, default GST, business state).
 *
 * Each item may carry its own discount as a percentage or a flat amount
 * (item.discountType: 'percent' | 'flat', default 'percent' for backward
 * compatibility with invoices saved before this feature existed).
 *
 * An additional invoice-level discount (on the post-item-discount subtotal)
 * can also be applied, again as a percentage or a flat amount. It is
 * allocated proportionally across line items before tax so GST is computed
 * on the actually-discounted amount even when items have different GST rates.
 */
function calcInvoiceTotals(items, customer, settings, overallDiscount) {
  const gstEnabled = settings.taxType !== 'Non-GST';
  const odValue = Number(overallDiscount?.value) || 0;
  const odType = overallDiscount?.type === 'flat' ? 'flat' : 'percent';

  let subtotal = 0, itemDiscountTotal = 0;
  const lines = items.map(it => {
    const qty = Number(it.qty) || 0;
    const rate = Number(it.rate) || 0;
    const discount = Number(it.discount) || 0;
    const discountType = it.discountType === 'flat' ? 'flat' : 'percent';
    const gst = Number(it.gst) || 0;
    const gross = qty * rate;
    const itemDiscAmt = discountType === 'flat' ? Math.min(discount, gross) : gross * discount / 100;
    const lineTaxable = gross - itemDiscAmt;
    subtotal += gross;
    itemDiscountTotal += itemDiscAmt;
    return { lineTaxable, gst };
  });

  const sumTaxableBeforeOverall = lines.reduce((s, l) => s + l.lineTaxable, 0);
  const overallDiscountAmt = Math.max(0, Math.min(
    odType === 'flat' ? odValue : sumTaxableBeforeOverall * odValue / 100,
    sumTaxableBeforeOverall
  ));

  let totalTax = 0;
  lines.forEach(l => {
    const share = sumTaxableBeforeOverall > 0 ? l.lineTaxable / sumTaxableBeforeOverall : 0;
    const allocatedDiscount = overallDiscountAmt * share;
    const lineFinalTaxable = l.lineTaxable - allocatedDiscount;
    totalTax += gstEnabled ? lineFinalTaxable * l.gst / 100 : 0;
  });

  const taxable = sumTaxableBeforeOverall - overallDiscountAmt;
  const discountTotal = itemDiscountTotal + overallDiscountAmt; // combined, for display

  const sameState = customer
    ? (customer.state || '').trim().toLowerCase() === (settings.businessState || '').trim().toLowerCase()
    : true;

  let cgst = 0, sgst = 0, igst = 0;
  if (gstEnabled) {
    if (sameState) { cgst = totalTax / 2; sgst = totalTax / 2; }
    else { igst = totalTax; }
  }
  const grandTotal = taxable + totalTax;

  return {
    subtotal: round2(subtotal),
    itemDiscountTotal: round2(itemDiscountTotal),
    additionalDiscountAmt: round2(overallDiscountAmt),
    additionalDiscount: odValue,
    additionalDiscountType: odType,
    discountTotal: round2(discountTotal),
    taxable: round2(taxable),
    cgst: round2(cgst),
    sgst: round2(sgst),
    igst: round2(igst),
    totalTax: round2(totalTax),
    grandTotal: round2(grandTotal),
    sameState,
    gstEnabled
  };
}

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
  "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function twoDigits(n) {
  if (n < 20) return ONES[n];
  return TENS[Math.floor(n / 10)] + (n % 10 ? " " + ONES[n % 10] : "");
}
function threeDigits(n) {
  let s = "";
  if (n >= 100) { s += ONES[Math.floor(n / 100)] + " Hundred "; n %= 100; }
  s += twoDigits(n);
  return s.trim();
}
function numToWordsIndian(num) {
  num = Math.round(num);
  if (num === 0) return "Zero";
  let crore = Math.floor(num / 10000000); num %= 10000000;
  let lakh = Math.floor(num / 100000); num %= 100000;
  let thousand = Math.floor(num / 1000); num %= 1000;
  let rest = num;
  const parts = [];
  if (crore) parts.push(threeDigits(crore) + " Crore");
  if (lakh) parts.push(threeDigits(lakh) + " Lakh");
  if (thousand) parts.push(threeDigits(thousand) + " Thousand");
  if (rest) parts.push(threeDigits(rest));
  return parts.join(" ").trim();
}
function amountInWords(n, currency) {
  const m = curMeta(currency);
  const whole = Math.floor(n);
  const minor = Math.round((n - whole) * 100);
  let str = `${m.major} ${numToWordsIndian(whole)} Only`;
  if (minor > 0) str = `${m.major} ${numToWordsIndian(whole)} and ${numToWordsIndian(minor)} ${m.minor} Only`;
  return str;
}

function fmt(n, currency) {
  const m = curMeta(currency);
  return m.symbol + (Number(n) || 0).toLocaleString(m.locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

module.exports = { calcInvoiceTotals, amountInWords, fmt, curMeta, round2 };
