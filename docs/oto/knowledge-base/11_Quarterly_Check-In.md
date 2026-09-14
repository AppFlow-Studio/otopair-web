# Quarterly Check-In

## Overview

Every 90 days, Otopair shows a soft banner on the Home screen asking the driver "how's your car?" It's a short data refresh that keeps maintenance recommendations accurate as the car ages and miles accumulate.

## Why quarterly

Services happen outside the app. Symptoms appear. Driving patterns shift. If the engine only knows what it learned at onboarding, recommendations drift further from reality every week. **Quarterly** is the right cadence because it aligns with natural ownership rhythms — seasonal tire changes, inspection cycles, oil change intervals. Monthly is too aggressive. Semi-annual is too stale.

## The rule behind every question

Every question must change a number in the engine. If a question doesn't adjust an interval, shift a risk score, change a recommendation, or update a confidence level — it doesn't belong in the check-in. This is data collection, not engagement theater.

## How it surfaces

- A non-blocking **banner on the Home screen** when a check-in is due
- **No push notification** — never, under any condition
- **No badge** on the app icon
- The banner is dismissible — no escalation, no lock-out

Example banner copy: *"It's been a few months — quick check-in to keep your [car name] on track."*

## What it asks

The check-in adapts to the vehicle's mode (Lease, Owned New, Owned Active, Owned Endurance, Owned Weekend). Most modes see between **3 and 7 core questions** plus a few optionals — typically completed in **under 60 seconds**.

Common questions include:
- Current mileage
- Any services done elsewhere since the last check-in
- Any warning lights on the dashboard
- Any unusual symptoms (noises, vibrations, pulling)
- For leases: mileage pace vs. allowance

## What happens if it's ignored

- **14 days ignored:** banner language softly shifts to signal staleness — still no push, still dismissible
- **30+ days ignored:** the Vehicle Health score shows an **"(estimated)"** qualifier next to the number. The score itself doesn't change — just the confidence label
- **Never:** the check-in does NOT gate features, lower the health score, or penalize the driver in any way

## What completion feels like

- Calm confirmation: *"All set — your [car name] is up to date."*
- No confetti, no "great job," no gamification
- Updated maintenance recommendations appear immediately

## How to answer common questions

**"Do I have to do the quarterly check-in?"**
"No, but it is recommended. It helps us keep recommendations accurate for your car. Most people get through it in under a minute."

**"What happens if I skip it?"**
"Nothing bad. After about a month, your Vehicle Health score gets a small '(estimated)' note next to it — that's just to remind you the data might be a little stale. The score doesn't drop, and nothing locks up."

**"What's in it?"**
"Quick stuff — current mileage, any services you did elsewhere, any warning lights, anything weird you've noticed. Three to seven questions, usually under a minute."

## Important boundaries

- Do **not** describe the check-in as required or recommend completing it urgently
- Do **not** explain the internal mode-classification logic
- Do **not** describe how answers change interval calculations internally
- The right tone is "a friend asking how the car is" — not a form, not a survey
