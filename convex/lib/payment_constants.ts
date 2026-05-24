/**
 * payment_constants.ts — Constants for the Pre-Job Approval Booking Flow
 * payment lifecycle. Single source of truth so the deposit amount stays
 * consistent across PI creation, capture-on-forfeit, and reauth paths.
 */

/**
 * Fixed Stripe authorization placed at booking time. The most we ever block
 * on the customer's card before the mechanic has inspected the vehicle.
 *
 * - Fair to customer: small commitment, not the full estimated total.
 * - Fair to mechanic: captured as forfeit if customer no-shows or doesn't
 *   respond to the pre-job estimate within the SLA window.
 * - Incentive to engage: customer is motivated to show up to avoid the $20
 *   capture; mechanic is motivated to actually do the inspection knowing
 *   the deposit is theirs if the customer flakes.
 *
 * Hold is incremented to the mechanic's confirmed set price after
 * inspection — silent within the disclosed range, customer-approved
 * outside it.
 */
export const BOOKING_DEPOSIT_CENTS = 2000;
