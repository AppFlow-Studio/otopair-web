# Quarterly Check-In

## Overview

Every 90 days, the Otopair app asks the driver a few quick questions about the car. It's a short data refresh that keeps maintenance recommendations and the Vehicle Health Score accurate as the car ages and miles accumulate — the app has no way to read the odometer, so it asks.

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

Three questions: the current mileage, anything done elsewhere since the last check-in, and whether the car is telling you anything — a warning light, a noise, or something that feels off. It takes about 30 seconds, and it's optional.

Answers are self-reported: the mileage refreshes when each item comes due, and warning lights the driver reports are logged against the car. A record from a shop is what makes an item verified.

## What happens if it's skipped

- Skip it and the Vehicle Health Score is shown as an estimate until the driver answers
- **Never:** the check-in does NOT gate features, charge anything, or penalize the driver in any way

## What completion feels like

- Calm confirmation: *"All set — your [car name] is up to date."*
- No confetti, no "great job," no gamification
- Updated maintenance recommendations appear immediately

## How to answer common questions

**"Do I have to do the quarterly check-in?"**
"No — it's optional. It keeps your recommendations and your health score current, and it takes about 30 seconds."

**"What happens if I skip it?"**
"Nothing bad. Your Vehicle Health Score just shows as an estimate until you answer."

**"What's in it?"**
"Three quick questions — your mileage, anything done elsewhere since last time, and whether the car's telling you anything, like a warning light or a noise. About 30 seconds."

## Important boundaries

- Do **not** describe the check-in as required or recommend completing it urgently
- Do **not** explain the internal mode-classification logic
- Do **not** describe how answers change interval calculations internally
- The right tone is "a friend asking how the car is" — not a form, not a survey
