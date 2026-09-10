# Otopair knowledge base (seed)

Every question and answer written for the marketing pages during the Sep-5 2026 design pass, gathered in one place so a support site can be built from it later. The pages themselves now keep only a short "Questions drivers ask" / "Questions shops ask" list; the long explanations live here.

Every fact below was checked against the product code when it was written (the web repo's Convex functions and the driver app in otopair-1). Sources are noted per section so a future edit can re-check. Locked copy rules for anything published: no platform fee rate, no price ranges or "from $X", payouts are "through Stripe on Stripe's payout schedule", reviews are one-way from completed bookings, "verified" means approval by the Otopair team, the $20 hold is the only number at booking, the approved price is a ceiling, 24 hours to answer an estimate, 22 bookable services in four categories, no launch date.

---

## 1. How a booking works, in seven steps

Source: convex/lib/payment_constants.ts ($20 hold), convex/booking_approvals.ts (in-range auto-confirm, 24-hour window), convex/bookings.ts (capture on completion), constants/serviceTaxonomy.ts in otopair-1 (the catalog).

1. **Say what the car is doing.** By text or voice, the way you would tell a friend: the noise, the light, the feel. No form, no service menu to guess from.
2. **Oto scopes the job and decodes your VIN.** Oto asks what it needs to, turns the symptom into one of Otopair's 22 bookable services, and reads your exact vehicle from its VIN so the price is built for your car.
3. **Compare the totals, pick a shop, pick a slot.** Every shop that can do the job appears with its own full total for your car: parts, labor and tax inside it.
4. **Confirm. A $20 hold reserves the slot.** Nothing is charged at booking. A $20 authorization holds your appointment and is the most placed on your card before the shop has seen the car.
5. **Drop off. The shop confirms the final price.** After inspecting the car the shop confirms its price in the app. Within what you approved, it goes through without another tap.
6. **Approve anything extra in the app.** Above what you approved, or added work the shop finds, comes to you as an estimate with 24 hours to say yes or no. Declined work is never charged.
7. **Pay when the job is marked complete.** You are charged only then, and the receipt in the app records what was done and what was paid.

### Questions

**Do I need to know what is wrong with my car?**
No. Describe what you notice and Oto asks the rest. It turns the symptom into a scoped job so shops can price it, and the shop's inspection decides the actual work. Oto is a guide, not a diagnosis.

**Is the price really locked?**
The price you approve when you book is a ceiling. After inspecting the car the shop confirms the final price; if it is within what you approved it is confirmed automatically, and it cannot go above that without your explicit approval in the app. Nothing you decline is ever charged.

**What does the $20 hold do?**
It reserves your slot. It is an authorization on your card, not a charge, and the most placed on your card before the shop inspects the car. After the shop confirms the price the hold is raised to that amount, and it is captured when the shop marks the job complete; cancel in time and it is released. The cancellation policy lists every case.

**Can I book from a web browser?**
Drivers book in the Otopair app for iPhone and Android, where Oto, the price lock and the booking live. Store listings are on the way; the download page has the waitlist. Repair shops use a separate web dashboard.

**What if the shop finds something else once the car is on the lift?**
It sends the added work and its price in the app. You approve it or decline it there, with 24 hours to answer. Declined work is stripped from the job and never charged; the shop completes what you originally booked.

**What does "verified shop" mean?**
A shop that Otopair has reviewed and approved by hand; that review is what the badge means. Being bookable is a separate, mechanical gate: a payments account through Stripe that can receive payouts, opening hours for every day of the week, at least one mechanic, at least one offered service and a labor rate. The shops listed on the site have cleared both. Reviews on Otopair come only from drivers, only after a completed booking.

**Where does it work?**
Staten Island, New York, today. Every shop listed on the site is an independent shop on the island that Otopair has reviewed and approved and that is taking bookings, and a driver from anywhere can book one. Brooklyn is planned for Q4 2026, then Queens, The Bronx and Manhattan. The coverage page has the live map and a waitlist for each borough.

---

## 2. Oto, the assistant in the app

Source: convex/oto/prompt/stable.ts (capability honesty and hard rules), convex/oto/safety.ts (hazard classifier), otopair-1 components/ai-chat.

**What Oto is.** The assistant inside the Otopair app. You describe what your car is doing in your own words, by typing or by voice where the app offers it, and Oto asks one narrowing question, turns your answer into a scoped job a shop can quote, and hands you to the booking flow. The mechanic confirms what you actually need before any work.

Oto is not a mechanic, not a lawyer and not a salesperson; it is an educational assistant that helps you feel less in the dark about your car. If what you describe maps to one of the 22 bookable services, Oto sets that service up. If it does not, Oto sets up a Diagnostic Scan with your notes attached so a mechanic sees exactly what you told it. Reaching for the scan is the honest outcome, not a failure: Oto never guesses a repair from a symptom. There is no live human on the other end of the chat. Oto never speaks as a shop or a mechanic, and if you ask to talk to one it says so in one line and gets you booked with one instead.

### What Oto can do

Everything here is backed by a real tool inside the app; if something is not here, Oto cannot do it and says so.

- Explain the 22 bookable services and describe any of them in detail.
- Tell you what is due on your car, show your Vehicle Health Score, and show what the score would be if you took care of the worst item.
- Look up your bookings, pending, active or completed, and show them as cards.
- Pull the specs for your own car, or for any car in Otopair's catalog.
- Prefill the booking flow with the right service. You choose the shop, the time and the payment yourself, inside the booking screen. Oto never books, schedules or pays on its own.
- Take you to the right screen: settings, your profile, transaction history, customer support, feedback or a bug report.
- Log your mileage and dashboard warning lights with a confirm card. Nothing is written to your car's record until you tap confirm.
- Show your rewards balance and history and explain how the program works. Redeeming happens on the Loyalty screen, not in chat.
- Remember facts about your car from one chat to the next.
- Take a thumbs up or thumbs down on every answer.

### What Oto never does

These are hard rules in how Oto is built, not tone preferences, and Oto states them plainly instead of working around them. Booking and payment are for people 18 and over: Oto will still answer car questions, but it will not start a transaction for anyone under 18.

- **Walk you through a repair.** In Oto's own words: "I don't walk through repair procedures; too much rides on torque and sequence." Reading a dashboard symbol, finding the dipstick or checking tire pressure is fine; anything that involves a wrench goes to a shop, or to the manufacturer's service manual if you want to learn it.
- **Quote a price, a parts price, labor hours or how long a job takes,** not even a hedged range. Its answer is: "Can't give you a number; it depends on the shop. Pick one and you'll see the real quote before you pay." The one thing it will say is that the New York State inspection fee is set by the state, and you still see the exact amount before you confirm.
- **Evaluate your legal case.** Oto can tell you what lemon law is. It cannot tell you whether you have a case, and it will not refer you to an attorney.
- **Send a tow truck or roadside help.** Otopair does not tow, jump-start or come to a stranded vehicle. If you are broken down, Oto says that up front so you are not waiting for help that is not coming.
- **Read photos.** If you attach one, Oto asks you to describe what you are seeing instead, and never guesses what a picture probably shows.
- **Look up open recalls for your VIN.** Oto has no recall integration; NHTSA is the authority for that.
- **Pretend to be a human, a shop or a mechanic.** It is always Oto, and it says so.
- **Upsell.** Oto never bundles an unrelated service onto your question, never brings up something it offered before that you did not book, and never asks why you did not book.
- **Book, pay, file a dispute or send messages for you.** You confirm bookings and payment in the booking screen; support and disputes have their own screens; and updates arrive in the app, on the booking, never by a call or text Oto promised.

### Safety

If you describe fire, smoke, fumes, a brake or steering problem, overheating, a wheel coming loose, lost visibility or a serious warning light, Oto tells you to stop driving first, before any question, any explanation and any booking offer. A check runs on every message before Oto sees it, keyed on the hazard itself and not on how worried you sound, because the drivers most at risk are usually the ones who do not know to worry.

After the instruction, Oto helps normally: it answers what you asked and offers a Diagnostic Scan for once the car is somewhere safe. If checking something yourself would help, it is offered as a choice, never assumed, and a self-check never cancels a stop-driving instruction.

Two situations override everything else. If you say something that suggests you might hurt yourself, Oto gives you the 988 Suicide and Crisis Lifeline and stops. If you mention being hurt, a burn, a cut, dizziness from fumes, the only thing Oto says about it is to get medical help; it never gives first-aid instructions.

### Memory

One chat is anchored to one car. Within a conversation Oto keeps the facts you have established, your mileage, the symptom, whether the brakes were done recently, so it does not ask twice. Across conversations it can remember durable things you tell it about yourself: a preference for the closest shop, how much you drive, a service you had done elsewhere, or a topic you have asked it to drop.

You can retract any of it. Tell Oto you meant the oil light rather than the check-engine light, or that you have changed your mind about a preference, and the record is corrected. Oto never invents service history: if it has no record of your last brake job it says so and offers a one-tap way to add one.

Every answer carries a thumbs up and a thumbs down, tied to your account, and Otopair staff can review a conversation you rate down. What is collected and how long it is kept is in the privacy policy.

### The website demo

The "Talk to Oto" on the home page is a demo agent for the website. It can show sample cards, decode a VIN you give it and walk through a mock booking, but it creates no real booking (the confirm step shows a sample receipt) and it has no access to anyone's car records, bookings or health score. The real Oto lives in the Otopair app, signed in, with your car attached.

### Questions

**What can Oto do?**
Oto explains the 22 services you can book, tells you what is due on your car and shows your Vehicle Health Score, looks up your bookings, pulls the specs for your car, logs your mileage and warning lights when you confirm, and sets up the booking flow with the right service prefilled. You choose the shop, the time and the payment yourself. Oto does not diagnose the car: it scopes what you describe into a job a mechanic can quote, and the mechanic confirms what you actually need before any work.

**How does pricing work?**
The shop sets the price, and Oto never quotes one. Before you confirm a booking you see the full total for your exact car, with parts, labor, tax and Otopair's service fee inside it, and a $20 hold is placed on your card. After inspecting the car the shop confirms the final price. It cannot go above what you approved without your in-app approval, and if the shop cancels or the request expires the hold is released in full.

**How do rewards work?**
Otopair pays real dollar credit, not points. You earn credit on every completed booking, and extra credit for leaving a review, uploading a service record, or referring a friend who completes their first booking. Credit applies to your next booking automatically, or you can convert your balance to a gift card. Oto can show your balance and history; the amounts, tiers and terms are shown in the app.

**Where is Oto available?**
The shops Oto can book are in Staten Island, NY today. Brooklyn is planned for Q4 2026, Queens for Q1 2027, The Bronx for Q2 2027 and Manhattan for Q3 2027. Oto lives in the Otopair app for iPhone and Android; the assistant on this website is a demo that creates no real booking.

---

## 3. Pricing, the $20 hold and approvals

Source: convex/lib/payment_constants.ts, convex/booking_approvals.ts (SLA_MS), convex/bookings.ts, convex/lib/vehicleTiers.ts, convex/shopServiceFixedPrices.ts, otopair-1 booking/mechanic/[id]/payment.tsx and booking/approve-estimate/[id].tsx.

**Who sets the price?**
The shop. Every shop on Otopair sets its own labor rates, by vehicle tier, and may set a flat price for a service, per vehicle tier, instead. Otopair does not set shop prices, does not negotiate them for you, and does not pad them. What Otopair does is show you each shop's total for your exact car so you can compare, then lock the one you choose.

**What do I see before I confirm?**
The full total for your exact car, from each shop that can do the job: parts, labor, tax and Otopair's service fee are all inside it, and nothing is added after you confirm. The total is built for your vehicle's exact configuration in the app, which is why Otopair publishes no price lists. Because the shop has not seen the car yet, the app shows that total as a disclosed range for your car. The number you approve when you book is the top of it, and the final price cannot go above it without your approval in the app.

**What is the $20 hold?**
A $20 authorization on your card that reserves your slot. It is a hold, not a charge, and it is the most Otopair ever blocks before the shop has inspected the car. After the shop confirms the price the hold is raised to that amount; it is captured when the shop marks the job complete, and if the booking is cancelled in time it is released. The cancellation policy lists every case.

**What happens after the shop inspects the car?**
The shop confirms the final price in the app. If it lands within what you approved when you booked, no further approval of the price is needed; if you paid with Apple Pay or Google Pay, the app may ask you to re-confirm the hold at the new amount. If it is above that, you get the estimate in the app and 24 hours to approve or decline it. Nothing above what you approved is ever charged without that approval.

If the shop finds something the job did not cover, it sends the added work and its price the same way. Decline it and it is never charged; the shop completes what you originally booked. An estimate you leave unanswered for 24 hours after the inspection expires, and the $20 deposit is kept to pay the shop for the inspection.

**When am I actually charged?**
When the shop marks the job complete. Until then, the only thing on your card is the hold. At completion the confirmed price is captured, the shop is paid through Stripe on Stripe's payout schedule, and you get an itemised receipt in the app that records what was done and what was paid. Card details never touch Otopair's servers; payment runs through Stripe.

**What Otopair never does.** The same list that is in the app (the home page's trust card, components/flagship/oto-flow.ts TRUST_DEMO). The total you confirm is the total you pay. There is no countdown on a price, no "only two slots left," and no service added because a shop wanted the ticket to be bigger. Anything beyond what you booked has to go through your approval in the app.

### Questions

**Is there a booking fee for drivers?**
Nothing is charged to download the app, talk to Oto or get prices from shops. When you book, the total you confirm already includes everything: parts, labor, tax and Otopair's service fee. Nothing is added on top after you confirm, and the only thing placed on your card at booking is the $20 hold.

**Why does the app show a range for my car?**
Because the shop has not seen the car yet. Before inspection, the app shows a disclosed range built for your exact car; what you approve when you book is the top of it. After inspection the shop confirms the final price, and it cannot go above that range without your explicit approval in the app.

**Do shops pay to be on Otopair?**
There is no subscription and no setup fee for shops. Shops set their own rates and keep their rate; Otopair's service fee is part of the total the driver confirms.

**Can the shop charge me more at pickup?**
No. The final price cannot go above what you approved without your OK in the app. If the shop finds something extra, it sends the added work and its price in the app; if you decline it, it is never charged and the shop completes what you booked.

**Do prices differ between shops?**
Yes. Each shop sets its own labor rates and may set flat prices for some services, so the same job can cost different amounts at different shops. The app shows each shop's full total for your car side by side, and you choose.

---

## 4. Vehicle Health Score

Source: otopair-1 utils/healthScore.ts and utils/maintenanceStatus.ts, convex/oto/vehicleHealth.ts, convex/inspectionHealthDeferred.ts, otopair-1 components/cars.

**What it is, and what it tracks.** A number from 0 to 100 for your exact car, shown as a ring on the Cars tab of the Otopair app. It is built from your service records, your quarterly check-in answers, the warning lights you report and what a shop measures when it inspects the car, and it updates as each of those comes in. It is a score of upkeep, not a diagnosis. Tap the ring and the app shows the per-item breakdown, Oil, Brakes, Tires, State Inspection, Battery, each marked On time, Due soon, Needs attention, Overdue or Unknown, and what is pulling the score down. Ask Oto how your car is doing and it reads the same number, tells you what would move it, and never makes one up.

Four systems, engine oil, brakes, tires and the ordinary 12-volt battery, plus your New York State inspection when a record of it is on file. Brakes weigh the most, then tires and oil, then the battery. Nothing else is scored. That boundary matters: the score says nothing about a hybrid or electric vehicle's high-voltage traction battery, the transmission, the suspension, the air conditioning, the engine's internal condition, brake lines, the ABS module, alignment, or anything else. If a system is not on the list it has never been measured, and its absence means "not checked", not "fine". Even within the four, each item covers one thing:

- **Oil:** the oil and filter change interval. Not leaks, oil pressure or engine condition.
- **Brakes:** pad and rotor service history and wear. Not brake lines, the master cylinder or the ABS module.
- **Tires:** tread and rotation and replacement history. Not alignment, tire-pressure sensors or wheel condition.
- **Battery:** the 12-volt starter battery only. Never a hybrid or EV traction pack.
- **State inspection:** the safety and emissions inspection due date, only once you have a record on file.

**How it is calculated.** Up to 85 points come from the upkeep of the tracked systems, up to 15 points are a reserve you keep while no warning lights are on, and up to 15 points are deducted for open recommendations a mechanic has made. Round the result, keep it between 0 and 100, and that is the score.

- **Upkeep, up to 85 points.** Each tracked item is graded on time, due soon, needs attention or overdue from its service interval and your mileage. The grades are averaged with brakes weighted most, then tires and oil, then the battery, then inspection.
- **No-warning-lights reserve, up to 15 points.** Full while no dashboard light is on. Each active light you have reported reduces it; an oil-pressure light and an overheating light cost the most.
- **Open recommendations, up to 15 points deducted.** Work a mechanic recommended after seeing the car that is still open. The deduction is phased in over 30 days, so the score never drops suddenly.

If there is no record for a system, it is scored from mileage: a low-mileage car with no records is assumed to be close to fine, and that assumption falls as the miles climb, because missing history on a high-mileage car is a real flag. The fix is the same either way: add the record, or let a shop confirm it. A recommendation only counts when it is tied to one of the services you can book; a mechanic's free-form advisory note is shown to you but never moves the score.

**What moves the score.** Real upkeep, and only real upkeep. A due service completed, through Otopair or recorded from elsewhere, moves its item back to on time. Clearing a warning light restores the reserve. A shop inspection replaces guesses with measurements. Nothing you buy in the app changes the number.

- **Completing a due service.** Booking it through Otopair records it when the job completes; a service done elsewhere can be added as a record, or at the check-in.
- **Clearing a warning light.** Report it gone at a check-in, or in chat with Oto, and the reserve comes back.
- **A shop inspection.** Measured grades replace inferred ones.
- **Closing an open recommendation.** Doing the work, or the shop confirming it was done in the same visit, removes its deduction.
- **Time and miles.** Intervals come due with months and mileage, so a car that is driven and not serviced drifts down on its own.

**What does a shop inspection do?**
A mechanic's multi-point inspection replaces inferred grades with measured ones: tread depth on each tire, brake pad and rotor thickness at each corner, a battery load test, and fluid checks. The grades are applied shortly after the visit closes, and a problem found and fixed during the same visit never lowers the score.

Each grade carries the shop that made it and the reason, so the breakdown can say why an item changed rather than just show a colour. The tire grade is the worst of the four corners; the battery grade is the load test when one was run; the brake grade blends pad, rotor and brake-fluid findings. If the mechanic recommends work you decide not to do yet, that recommendation stays open and its deduction phases in over the following 30 days.

**What is the quarterly check-in?**
Every 90 days the app asks for your current mileage, any services done elsewhere, any warning lights, and anything unusual lately. Answering it keeps the score current. Your answers are recorded as self-reported, as distinct from records verified by a completed Otopair booking, an uploaded service record or a shop.

**What is the vehicle passport?**
The vehicle passport is a record, keyed to your car's VIN, of what shops have physically confirmed: mileage, tires, fluids, brakes, inspection status and modifications, with the dates of the first and most recent shop confirmation. It is written from the shop's pre-job and post-job reports during a booking, and it travels with the car, not the owner. The passport records when each section was last confirmed, not a line-by-line history, and it is separate from the score: the score grades upkeep, the passport holds the facts a shop measured. A shop's odometer reading updates your mileage with its source marked as a shop visit.

**How is it different from a dashboard light?**
A dashboard light is the car reporting a fault right now. The score is a picture of upkeep over time, and a lit warning light is one input into it, not something it replaces. If a light is on, deal with the light; the score will follow. The two also come from different places. The light comes from the car's own sensors. The score comes from records, your answers and shop measurements; nothing is read from the car's computer, so the score cannot see a fault the car has not shown you and you have not reported. The lights the app recognises are oil pressure, battery or charging, temperature, ABS, tire pressure, airbag, transmission and check engine, plus "not sure which" for when you cannot identify the symbol.

### Questions

**Is the Vehicle Health Score a safety rating?**
No. It grades the upkeep of four systems, oil, brakes, tires and the 12-volt battery, plus your state inspection when a record is on file. It does not test crashworthiness, it does not inspect anything it does not track, and a high score is not a statement that the car is safe to drive. A lit warning light or a stop-driving instruction from Oto always outranks it.

**Does it use my car's telematics or connected-car data?**
No. The score is built from service records, your quarterly check-in answers, the warning lights you report and what a mechanic measures during an inspection. Nothing is read from the car's computer or from any connected-car service, so the score cannot see a fault the car has not shown you and you have not reported.

**Can I raise my score by paying?**
No. Only real upkeep moves it: completing a service that is due, clearing a warning light, or a shop inspection that measures the car and finds it in good shape. Nothing you buy in the app changes the number, and there is no way to purchase a higher score.

---

## 5. For repair shops

Source: convex/lib/vehicleTiers.ts, convex/shopServiceFixedPrices.ts, convex/booking_approvals.ts, app/api/stripe/connect/start/route.ts, convex/director.ts (setShopVerified), lib/bookableShop.ts, convex/reviews.ts, app/(portal).

**How do I set my prices?**
From your dashboard, on your own terms. You set a labor rate for each vehicle tier you take, from mainstream cars through German and performance makes to exotics, and you can decline any tier you do not want in the shop. For any service you can also set a flat price per tier, which replaces the labor-and-parts math with your advertised number. You choose which of the 22 bookable services you offer. The driver sees your total for their exact car, with tax and Otopair's service fee inside it, next to other shops' totals. Your rate is your rate; Otopair does not discount it or negotiate it.

**How do the $20 hold and approvals work on my side?**
The driver books with a $20 hold on their card. After you inspect the car you submit your estimate in the app. If it lands within the range the driver already approved, it is confirmed automatically and you get on with the job. If it is above that range, the driver gets the estimate and has 24 hours to approve or decline; you can withdraw and resend it while it waits. If a pre-job estimate goes unanswered for 24 hours, the $20 deposit is captured so you are paid for the inspection. Added scope mid-job goes through the same approval; declined work is stripped from the job and never charged, and you complete what was booked. Funds are captured when you mark the job complete, and the driver's receipt itemises what was done and paid.

**When do I get paid?**
Through Stripe Connect Express, on Stripe's payout schedule, once you mark the job complete and the confirmed price is captured. Every payment is listed in your dashboard, payouts follow your Stripe schedule, and the receipt for each job records the settlement facts Stripe actually moved. There is no subscription, no setup fee and no monthly charge.

**What does verification involve?**
A review by Otopair, plus a complete setup. Otopair reviews and approves each shop before it carries the verified badge. Separately, to be bookable a shop needs a Stripe Connect account with charges and payouts enabled, opening hours for all seven days, at least one mechanic on the team, at least one offered service, and a labor rate. Once those are in place, the shop appears to drivers and can take bookings. Verification is Otopair's own review of your shop and its setup. It does not certify anything beyond that, and the badge says only what it means: reviewed and approved by Otopair. Otopair does not check licences or insurance beyond the DMV inspection licence for shops offering State Inspection.

**How do reviews work?**
Only drivers write them, and only after a booking is completed: one review of the shop, and optionally one of the mechanic, per completed job. A shop cannot be reviewed by someone who never booked, and there is no rating of drivers. Otopair can hide a review that breaks the rules, but does not delete them.

**How do I join?**
Apply in about two minutes. Otopair reviews the shop and sends a private invite to set up: Stripe Connect, hours, team, services and rates. Shops anywhere in New York City can apply now; Staten Island is live today, and shops in the other boroughs can apply ahead of their borough's opening.

**Five steps to your first booking.**
1. Apply: legal name, owner, business email, phone and street address. Two minutes.
2. Review: a person on the Otopair team approves or declines every application by hand.
3. Invite: a private, single-use link that expires in seven days.
4. Stripe: identity and payout bank details are verified by Stripe, not by Otopair. Charges and payouts must be enabled before you can take a booking.
5. Set up: seven days of hours, a labor rate, the services you offer and at least one mechanic. Then you appear to drivers.

**The dashboard.**
- Schedule: a live grid of every mechanic and every hour. A booking lands and the day recalculates; overruns push the rest of the day for you, and the front desk sees it happen.
- Bookings and approvals: accept requests, send the post-inspection estimate, add scope mid-job. In-range confirms itself; anything above waits for the driver's OK.
- Rates and services: a labor rate for each vehicle tier you take, a flat price per service where you want one, and any of the 22 bookable services switched on or off.
- Team: mechanics and front desk with their own sign-ins and views. Mechanics see the job, never the driver's approved figure.
- Messages: booking-scoped threads with the driver: running late, what's the status, approve extra work, when will it be ready. Answered from the desk.
- Payouts and receipts: every payment listed, every receipt itemised with what Stripe actually moved, refunds issued from the same screen.

### Questions

**Does it cost anything to join Otopair?**
No subscription, no setup fee, no monthly. You set your rates and keep your rate. Otopair's service fee is part of the total the driver confirms in the app; you earn, then Otopair earns.

**Do I have to accept every booking?**
No. A booking request waits for your acceptance. If it goes unanswered it expires on its own, after 48 hours or 2 hours past the requested time, whichever comes first; the driver's hold is released and nothing is charged to anyone. You get reminders before that happens.

**What happens if the driver does not show up?**
After the appointment time passes with no arrival, the app reminds the driver and then asks your front desk to decide. If you mark the booking a no-show, the $20 deposit is kept as the no-show fee. If nobody at the desk decides, the booking is marked a no-show automatically and the driver's hold is released without a fee. A driver who cancels inside 24 hours forfeits the same deposit.

**Can I change my rates later?**
Yes. Labor rates by vehicle tier, the tiers you take, flat prices per service and the services you offer are all edited from your shop dashboard.

**What do drivers see about my shop?**
Your name, location and hours, the services you offer, the price you set for their specific job, photos you add, and reviews from drivers whose bookings with you were completed. The app never shows drivers your payout or Stripe details.

---

## 6. Coverage

Source: lib/coverage.ts.

**Where is Otopair available right now?**
Staten Island, New York. Every shop you can book in the app today is an independent shop on Staten Island that the Otopair team has approved and that is taking bookings. Drivers from anywhere can book a Staten Island shop.

**When is Otopair coming to Brooklyn, Queens, The Bronx and Manhattan?**
Brooklyn is planned for Q4 2026, Queens for Q1 2027, The Bronx for Q2 2027 and Manhattan for Q3 2027. A borough opens once enough verified shops are on the network to book from; each borough page has a waitlist that emails you when the first shops go live.

**Does Otopair come to my location?**
No. Otopair is a marketplace for booking a shop, not a mobile mechanic. You bring the car to the shop you booked, at the time you booked, and the price is locked before you go.

**Which neighborhoods on Staten Island are covered?**
The whole island. Shops are concentrated along the North Shore, the Hylan corridor and the South Shore. The Staten Island page lists every verified shop with its nearest neighborhood, and the shop directory has each one's hours and services.
