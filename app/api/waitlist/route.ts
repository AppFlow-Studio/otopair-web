import { NextRequest, NextResponse } from 'next/server';
import { fetchMutation } from 'convex/nextjs';
import { api } from '@/convex/_generated/api';
import { sendWaitlistConfirmationEmail, sendWaitlistNotificationEmail } from '@/email/send';
import { isValidEmail, normalizeEmail } from '@/lib/email';

/** "Jane van Dyke" → first "Jane", last "van Dyke". */
function splitName(name: string | undefined): { firstName?: string; lastName?: string } {
    const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return {};
    return { firstName: parts[0], lastName: parts.slice(1).join(' ') || undefined };
}

const str = (v: unknown, max: number) =>
    typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/**
 * The car Oto decoded from the visitor's VIN, when there is one. Only fields
 * of the right type are passed on, so a malformed body can't fail the save.
 */
function parseVehicle(raw: unknown) {
    if (!raw || typeof raw !== 'object') return {};
    const r = raw as Record<string, unknown>;
    const vin = str(r.vin, 17);
    if (!vin || !/^[A-HJ-NPR-Z0-9]{17}$/i.test(vin)) return {};
    return Object.fromEntries(
        Object.entries({
            vin,
            year: num(r.year),
            make: str(r.make, 60),
            model: str(r.model, 60),
            trim: str(r.trim, 60),
            displacementL: num(r.displacementL),
            cylinders: num(r.cylinders),
            fuelType: str(r.fuelType, 40),
        }).filter(([, value]) => value !== undefined)
    );
}

// Boroughs the coverage ladder announces but does not serve yet. The
// borough waitlist pages (/brooklyn, /queens, /bronx, /manhattan) post one
// of these; anything else is dropped rather than echoed into the email.
const BOROUGHS = new Set(['Brooklyn', 'Queens', 'The Bronx', 'Manhattan', 'Staten Island']);

// Honeypot field name — kept in sync with components/flagship/waitlist-guard.tsx.
const HONEYPOT_FIELD = 'company_website';
// A person takes seconds to read the form and type an email; an auto-submitting
// bot fires in well under this. Below it, we treat the submit as a bot.
const MIN_FILL_MS = 1500;

// Best-effort in-memory rate limit. Fluid Compute reuses instances, so this
// blunts a burst from one source on a warm instance — it is NOT a durable,
// cross-instance guarantee. For hard limits use the Vercel Firewall / BotID or
// a durable store (Convex, Upstash).
const RATE_WINDOW_MS = 10 * 60_000;
const RATE_MAX = 10;
const rateHits = new Map<string, number[]>();
function rateLimited(ip: string): boolean {
    const now = Date.now();
    const recent = (rateHits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    recent.push(now);
    rateHits.set(ip, recent);
    return recent.length > RATE_MAX;
}

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { email, name } = body;
        const borough =
            typeof body.borough === 'string' && BOROUGHS.has(body.borough) ? body.borough : undefined;
        // The app-launch list from the store-button waitlist (design pass
        // 2026-09-05): tagged so the team notification says which list it is.
        const list = body.list === 'app' ? 'App launch' : undefined;

        // --- Bot protection: honeypot + submit timing ------------------------
        // Silently accept (200) without sending anything. A bot must not learn
        // why it failed, and no email may fire for a trap hit.
        const honeypot = typeof body[HONEYPOT_FIELD] === 'string' ? body[HONEYPOT_FIELD] : '';
        const elapsedMs = typeof body.elapsedMs === 'number' ? body.elapsedMs : undefined;
        if (honeypot.trim() !== '' || (elapsedMs !== undefined && elapsedMs < MIN_FILL_MS)) {
            return NextResponse.json({ success: true }, { status: 200 });
        }

        // --- The email must be a real, well-formed address -------------------
        if (!isValidEmail(email)) {
            return NextResponse.json(
                { error: 'Please enter a valid email address.' },
                { status: 400 }
            );
        }
        const cleanEmail = normalizeEmail(email);
        const cleanName =
            typeof name === 'string' && name.trim() ? name.trim().slice(0, 80) : undefined;

        // --- Best-effort per-IP rate limit -----------------------------------
        const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
        if (rateLimited(ip)) {
            return NextResponse.json(
                { error: 'Too many attempts. Please try again in a few minutes.' },
                { status: 429 }
            );
        }

        // --- Every sign-up is a user ------------------------------------------
        // Create (or refresh) the pre-signup user in Convex: a users row with
        // no Clerk login, holding the name, email and — from Oto — the car.
        // Signing up in the app with the same email picks it up. Until this,
        // only Oto saved anyone; the launch-list modal, the borough waitlists
        // and the navbar form sent two emails and stored nothing.
        const contact = { email: cleanEmail, ...splitName(cleanName) };
        let saved = false;
        try {
            await fetchMutation(api.preSignups.createStub, { ...contact, ...parseVehicle(body.vehicle) });
            saved = true;
        } catch (error) {
            console.error('Failed to save the sign-up to Convex:', error);
            // A bad vehicle payload must not cost us the person: retry with
            // their contact details alone.
            if (body.vehicle) {
                try {
                    await fetchMutation(api.preSignups.createStub, contact);
                    saved = true;
                } catch (retryError) {
                    console.error('Failed to save the sign-up to Convex (contact only):', retryError);
                }
            }
        }

        // Send confirmation email to user
        const confirmationResult = await sendWaitlistConfirmationEmail({
            email: cleanEmail,
            name: cleanName,
        });

        if (!confirmationResult.success) {
            console.error('Failed to send confirmation email:', confirmationResult.error);
            // Continue anyway - we'll still send the notification
        }

        // Send notification email to the team
        const notificationResult = await sendWaitlistNotificationEmail({
            email: cleanEmail,
            name: cleanName,
            borough: borough ?? list,
        });

        if (!notificationResult.success) {
            console.error('Failed to send notification email:', notificationResult.error);
            // Continue anyway - user confirmation was sent
        }

        // Nothing stored and nobody emailed: don't tell them they're on the list.
        if (!saved && !confirmationResult.success && !notificationResult.success) {
            return NextResponse.json(
                { error: 'Failed to process waitlist signup. Please try again.' },
                { status: 500 }
            );
        }

        return NextResponse.json(
            {
                success: true,
                message: 'Successfully joined waitlist!',
                saved,
                confirmationSent: confirmationResult.success,
                notificationSent: notificationResult.success,
            },
            { status: 200 }
        );
    } catch (error) {
        console.error('Error processing waitlist signup:', error);
        return NextResponse.json(
            { error: 'Failed to process waitlist signup. Please try again.' },
            { status: 500 }
        );
    }
}
