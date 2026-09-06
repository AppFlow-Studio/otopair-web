import { NextRequest, NextResponse } from 'next/server';
import { sendWaitlistConfirmationEmail, sendWaitlistNotificationEmail } from '@/email/send';

// Boroughs the coverage ladder announces but does not serve yet. The
// borough waitlist pages (/brooklyn, /queens, /bronx, /manhattan) post one
// of these; anything else is dropped rather than echoed into the email.
const BOROUGHS = new Set(['Brooklyn', 'Queens', 'The Bronx', 'Manhattan', 'Staten Island']);

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { email, name } = body;
        const borough =
            typeof body.borough === 'string' && BOROUGHS.has(body.borough) ? body.borough : undefined;
        // The app-launch list from /download (design pass 2026-09-05): tagged
        // so the team notification says which list the signup came from.
        const list = body.list === 'app' ? 'App launch' : undefined;

        // Validate email
        if (!email || typeof email !== 'string' || !email.includes('@')) {
            return NextResponse.json(
                { error: 'Valid email is required' },
                { status: 400 }
            );
        }

        // Send confirmation email to user
        const confirmationResult = await sendWaitlistConfirmationEmail({
            email,
            name: name || undefined,
        });

        if (!confirmationResult.success) {
            console.error('Failed to send confirmation email:', confirmationResult.error);
            // Continue anyway - we'll still send the notification
        }

        // Send notification email to company
        const notificationResult = await sendWaitlistNotificationEmail({
            email,
            name: name || undefined,
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
