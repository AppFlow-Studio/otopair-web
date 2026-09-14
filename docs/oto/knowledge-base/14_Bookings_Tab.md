# Bookings Tab in the App

## Overview

The Bookings tab is where drivers see everything related to their active service activity. It has three top-level views: **Live Tracker**, **Upcoming**, and **Quotes**. Past bookings live in the Profile section so the Bookings tab stays focused on what's happening now.

## Live Tracker

Shows the **current job in progress** — what's happening with the driver's car while it's at the shop.

- Real-time status updates from the mechanic
- The job moves through phases like check-in, work in progress, and complete
- The driver can follow along without calling the shop

## Upcoming

Holds **confirmed future appointments**.

- Tap any row to see full booking detail: time, date, price breakdown, PDF receipt
- Reschedule a time directly from here
- Cancel from here too — no external page

## Quotes

Holds **pending tire-quote requests** waiting on shop responses.

- Shows the live status as quotes arrive
- Each quote shows price, date availability, and how it compares to the baseline
- The window stays open up to 10 minutes or until 5 shops respond
- Driver picks one to convert the quote into a confirmed booking

## How a job moves between views

A quote-request job starts in **Upcoming**, moves to **Quotes** when responses arrive, and lands in **Live Tracker** when the driver picks one and the day of service comes around. A standard booking (non-tire) goes straight from Upcoming to Live Tracker on the appointment day.

## Past bookings

- All completed bookings live in **Profile / Service History**, not in Bookings
- Each past booking has a full PDF receipt, the parts logged, and the service notes
- Drivers can re-book the same service with the same shop in one tap from history

## How to answer common questions

**"Where do I see my appointment?"**
"In your Bookings tab. Upcoming shows confirmed appointments, Live Tracker shows what's happening while your car is at the shop, and Quotes shows pending tire responses."

**"How do I track my service?"**
"Open the Bookings tab and tap Live Tracker. It shows the current stage of your job while it's happening at the shop — no need to call."

**"Where are my old bookings?"**
"In your Profile, under Service History. Past bookings live there with full receipts and notes."

## Important boundaries

- Do **not** promise specific Live Tracker update intervals
- Do **not** describe the internal job state machine in technical detail
- Do **not** claim Live Tracker shows minute-by-minute mechanic activity — it shows the major phases
