# Tiered Pre-Job Inspection Implementation Plan

## Summary

- Implement the PDF’s five inspection tiers in the existing multi-point inspection.
- Keep fresh inspections blank, require `Mark zone complete`, and use only completed zones for findings, Vehicle Health, PDFs, and derived pre-job data.
- Tire Rotation and Tire Balancing apply to all four corners.
- Tire Replacement applies only to its selected corners.
- Brake Pad Replacement and Rotor Replacement apply only to their selected axle.
- Tire Installation remains out of scope because it is not an active service.
- Tier inspection checks are observations, not additional bookable services.

## Inspection Requirements

### Tier 1 — Every visit

Require an actual response or explicit unavailable status, except odometer:

- Odometer: numeric only.
- Every non-replacement tire: tread depth, pressure, and overall condition.
- Every corner: visual brake state—Good, Monitor, Attention, or Not visible.
- Engine bay: oil, coolant, brake-fluid, and washer-fluid levels; warning lights; battery terminals.
- Front: exterior lights, windshield, wipers, and horn.
- Vehicle access: required `Is the vehicle on a lift?` Yes/No question.

Replacement-tire tread, pressure, and condition remain available but optional. Lift status is stored for telemetry only.

### Tier 2 — Wheel removed, lift not required

#### Triggering booked services

- Tire Rotation: all four corners.
- Tire Replacement: selected corners from `tire_specs.positions`.
- Tire Balancing: all four corners.
- Brake Pad Replacement:
  - Front → FL and FR.
  - Rear → RL and RR.
  - Both → all four corners.
- Rotor Replacement: the same selected-axle mapping.

#### Inspection checks for each applicable corner

- Inner and outer pad thickness in millimeters plus measurement method.
- Rotor thickness with the existing inch/millimeter selector plus measurement tool.
- Exact rotor-stamp text.
- Rotor condition descriptors.
- Caliper slides/boots condition.
- Brake-hose condition.
- Brake-pad brand/type.

These checks are inspection observations. They do not add tire, brake, or suspension services to the booking automatically.

Do not interpret the rotor stamp as a service limit.

Require a tagged rotor-stamp photo when:

- The current service removes that corner’s wheel.
- The vehicle has no prior accepted rotor-stamp photo evidence for that corner.

Record accepted evidence independently for FL, FR, RL, and RR. The photo must remain attached through final inspection submission before that corner receives permanent evidence credit.

Deleting a newly uploaded required photo during the active inspection makes the corner incomplete and restores the photo requirement. After successful submission, future system retention cleanup may delete the stored image without deleting the permanent evidence record, so that corner will not require another photo solely because the file was later removed.

`N/A` remains valid only when that corner does not have an applicable rotor.

### Tier 3A — Vehicle on lift with wheels installed

#### Triggering booked service

- Wheel Alignment.

#### Inspection checks

- Fluid leaks or drips.
- Torn CV boots.
- Leaking struts.
- Exhaust leaks or broken hangers.
- Undercarriage damage.

These are inspection observations, not additional bookable services.

### Tier 3B — Vehicle on lift with applicable wheels removed

#### Triggering booked services

- Tire Rotation: all four corners.
- Tire Replacement: selected replacement corners.
- Tire Balancing: all four corners.
- Brake Pad Replacement: both corners on the selected axle.
- Rotor Replacement: both corners on the selected axle.

Wheel Alignment is Tier 3A only and does not trigger Tier 3B.

#### Inspection checks for each applicable corner

- Steering-linkage play.
- Ball-joint play.
- Wheel-bearing play.

These checks do not create suspension, steering, or wheel-bearing services automatically. Yellow or red answers may appear as findings or recommendations, but any added work must continue through the existing mechanic-confirmed unforeseen-scope workflow.

The lift Yes/No response remains telemetry only. Tier 3 fields stay service-triggered even when the mechanic answers No; `Not visible` and `N/A` allow an honest response when access was unavailable.

### Tier 4 — Job-opened systems

Collect specifications, not old-component condition, when the component is being replaced:

- Oil Change: viscosity and type only.
- Coolant Flush: coolant type only.
- Brake Fluid Flush: brake-fluid type only.
- Transmission Fluid Service: fluid type only.
- Power Steering Flush: fluid type only.
- Engine/Cabin Air Filter replacement: no old-filter condition requirement.
- Battery Test: CCA and terminal condition remain required.

### Tier 5 — Tire identity

Require tire brand, model, size, DOT code, and run-flat status:

- On the vehicle’s true first shop visit.
- Later, only for a corner whose tread reading exceeds the latest stored reading.

Keep brand, model, DOT, and run-flat per corner; keep size shared within its axle. Never prefill from prior visits.

## Interfaces and Persistence

- Extend zone state with per-field unavailable statuses, measurement methods, and tagged photo associations.
- Add per-corner rotor-photo evidence to the vehicle passport, storing at minimum:
  - Corner.
  - First accepted timestamp.
  - Source inspection ID.
- Grant permanent rotor-photo evidence only during successful final inspection submission while the newly required tagged photo remains attached.
- Keep evidence independent from the photo’s Convex storage ID so future retention cleanup can remove the file without removing evidence.
- Do not grant evidence at upload time, zone-completion time, or draft save time.
- Add lift status, true first-visit status, prior tread readings, rotor-photo evidence, and booking-derived Tier 2/3 scope to inspection context.
- Store lift status and odometer on the vehicle-inspection record.
- Reuse:
  - `tire_specs.positions` for Tire Replacement.
  - `selected_service_options` for Brake Pad Replacement axle.
  - `rotor_specs.axle` or an explicit axle option for Rotor Replacement.
- Do not default a missing brake axle to all four corners. Show a blocking inline booking-scope error until a valid axle is supplied.
- Derive legacy axle pad thickness from the shallowest inner/outer measurement on that axle.
- Retain entered rotor units and normalized values.
- Flag brake-fluid-level declines against the latest completed inspection.
- Never clear an existing warning or recommendation solely because a later visual result is green.
- Reuse shared client/server validation so Convex enforces identical requirements.

## Test Plan

- Verify Tier 1 for every service and only the intended replacement-tire exemptions.
- Verify lift telemetry is required and persisted without affecting booking scope or pricing.
- Verify Tire Rotation and Tire Balancing apply to all four corners.
- Verify Tire Replacement applies only to selected positions.
- Verify Brake Pad and Rotor Replacement correctly handle Front, Rear, and Both.
- Verify missing brake axle scope produces an inline blocking error.
- Verify Wheel Alignment receives Tier 3A only.
- Verify Tier 3 inspection checks never create additional booked work automatically.
- Verify yellow/red Tier 3 results require mechanic confirmation through unforeseen scope before changing the job.
- Verify `Not visible` and `N/A` satisfy Tier 3 without being treated as green.
- Verify rotor-photo evidence independently for FL, FR, RL, and RR.
- Verify a wheel-off corner without evidence requires a tagged photo.
- Verify a corner with accepted evidence does not require another photo.
- Verify uploading and deleting a required photo before submission restores the requirement and grants no evidence.
- Verify draft saves and zone completion do not grant permanent evidence.
- Verify successful final submission grants evidence only for tagged photos still attached.
- Verify future storage cleanup can remove the image while preserving evidence.
- Verify Tier 4 requires specifications but not old-component condition.
- Verify Tier 5 first-visit and higher-tread triggers.
- Verify unavailable statuses remain distinct and are never treated as green.
- Verify drafts resume only for the same booking, edits invalidate completion, and unconfirmed entries block save/submit.
- Verify client and server reject the same invalid inspection state.
- Verify only completed zones reach findings, PDFs, Vehicle Health, and the derived payload.

## Assumptions and Team-Discussion Flags

- Rotor-photo evidence belongs to the vehicle corner where the rotor is installed, not to the removable tire being rotated.
- Brake Pad Replacement axle selection is a required booking dependency, even though the current mobile deployment has not received that catalog update yet.
- Omit `Tires match?` and its mismatch-based Tier 5 trigger.
- Collect brake-pad brand/type only during wheel-off access.
- Use the clarified Tier 3A/Tier 3B definitions.
- Treat lift status as telemetry while services determine Tier 3 scope.
- Retain inches and millimeters for rotor thickness.
- Exclude Tire Installation and a dedicated NY State Inspection checklist.
