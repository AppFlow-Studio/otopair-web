# Payments

## Accepted payment methods

- **Apple Pay** (iPhone)
- **Google Pay** (Android)
- **Credit cards** (Visa, Mastercard, American Express, Discover)
- **Debit cards**

## How paying works — the $20 hold

1. **You book** — a **$20 hold** goes on your card or wallet. It's a hold, not a charge: no money moves when you book, and if you show up, or cancel 24 hours or more before, the $20 is never charged. It's the same for every booking and every shop
2. **The shop inspects the car and confirms the price** — within what you approved, that happens without another tap; above it, the app asks you to approve first
3. **The shop marks the job complete** — you're charged the confirmed price. That's the only moment a completed job is charged, and it's never more than you approved

- Card holds expire after about 7 days, so a booking made well ahead of the appointment may need the same $20 hold re-confirmed before the visit. Nothing extra is charged
- The $20 is kept in only three cases: a cancellation inside 24 hours, a no-show marked by the shop, or an inspection estimate left unanswered for 24 hours. Every case is in "Cancellations, Disputes and Warranty"

## Your card and Stripe

- Payments run through Stripe. Cards are entered directly in Stripe's payment sheet in the app, so the card number never reaches Otopair
- Otopair keeps only the card brand and the last four digits, for the receipt, plus Stripe's references for the hold and the charge
- The money stays with Stripe until the job is done. Shops are paid through Stripe, on Stripe's payout schedule, after the job is complete — Otopair doesn't hold shop money itself

## Receipts

- Once the payment settles, an itemized receipt shows every line and what happened to the hold, with the settlement figures read from the actual charge
- The receipt stays on the booking in the app. The receipt email carries a private link that opens it without signing in — anyone holding the link can open that receipt, so it shouldn't be forwarded

## How to answer common questions

**"Can I pay with X?"**
- If it's on the list above: confirm
- If not: "We support Apple Pay, Google Pay on Android, and credit or debit cards at launch. Other methods may come later"

**"Is the $20 a charge?"**
"No — it's a hold, not a charge. Show up, or cancel 24 hours or more ahead, and the $20 is never charged; you pay the confirmed price when the job's done, never more than you approved. The $20 is only kept if you cancel inside 24 hours, don't show up, or leave the shop's inspection estimate unanswered for 24 hours."

**"When do I actually pay?"**
"When the shop marks the job complete — the confirmed price, never more than you approved."

**"Do you store my card?"**
"No — your card number never reaches Otopair. It's entered directly with Stripe, and Otopair keeps just the brand and the last four digits so your receipt shows which card you used."

## Important boundaries

- You can say payments and shop payouts run through Stripe, as the site does. Do **not** describe internal payment workflow or financial architecture
- Do **not** describe how the hold is adjusted or captured behind the scenes — say it's a hold, not a charge, and when the driver pays
- Refunds usually reach the card within 5–10 business days and the bank controls the last step — never promise a date
- Do **not** say the $20 is always refunded, or that it's never kept
- Refunds, disputes and cancellation fees are explained in "Cancellations, Disputes and Warranty"
