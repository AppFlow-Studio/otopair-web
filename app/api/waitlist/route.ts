import { NextRequest, NextResponse } from 'next/server';
import { sendWaitlistConfirmationEmail, sendWaitlistNotificationEmail } from '@/email/send';
import { isValidEmail, normalizeEmail } from '@/lib/email';

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

        return NextResponse.json(
            {
                success: true,
                message: 'Successfully joined waitlist!',
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
