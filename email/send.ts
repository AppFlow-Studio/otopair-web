import { Resend } from 'resend';

let _resend: Resend | null = null;
function getResend(): Resend {
  if (_resend) return _resend;
  const key = process.env.RESEND_KEY;
  if (!key) throw new Error('RESEND_KEY is not configured');
  _resend = new Resend(key);
  return _resend;
}
// Backwards-compatible accessor for existing call sites (sendInviteEmail,
// waitlist helpers) that referenced the module-level `resend` constant.
const resend = new Proxy({} as Resend, {
  get(_t, prop) {
    const r = getResend() as any;
    const v = r[prop];
    return typeof v === 'function' ? v.bind(r) : v;
  },
});

/**
 * Send invite link email to an existing Clerk user
 */
export async function sendInviteEmail({
  email,
  inviteUrl,
  shopName,
}: {
  email: string;
  inviteUrl: string;
  shopName?: string;
}) {
  try {
    const result = await resend.emails.send({
      from: 'Otopair <info@otopair.com>',
      to: email,
      subject: shopName
        ? `You've been invited to join ${shopName} on Otopair`
        : "You've been invited to join a shop on Otopair",
      html: `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>You're Invited to Otopair</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f9fafb;">
  <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #f9fafb;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" style="max-width: 600px; width: 100%; border-collapse: collapse; background-color: #ffffff; border-radius: 12px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
          <!-- Header -->
          <tr>
            <td style="padding: 40px 40px 30px; text-align: center; background: linear-gradient(135deg, #0d72ff 0%, #3b82f6 100%); border-radius: 12px 12px 0 0;">
              <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 700; letter-spacing: -0.5px;">You're Invited!</h1>
            </td>
          </tr>

          <!-- Content -->
          <tr>
            <td style="padding: 40px;">
              <p style="margin: 0 0 20px; color: #1f2937; font-size: 16px; line-height: 1.6;">
                Hi there,
              </p>

              <p style="margin: 0 0 20px; color: #1f2937; font-size: 16px; line-height: 1.6;">
                You've been invited to join ${shopName ? `<strong>${shopName}</strong> on ` : ''}<strong>Otopair</strong>. Click the button below to accept your invitation and get started.
              </p>

              <!-- CTA Button -->
              <table role="presentation" style="width: 100%; border-collapse: collapse; margin: 30px 0;">
                <tr>
                  <td align="center" style="padding: 0;">
                    <a href="${inviteUrl}" style="display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #0d72ff 0%, #3b82f6 100%); color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; box-shadow: 0 4px 14px rgba(13, 114, 255, 0.3);">
                      Accept Invitation
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin: 20px 0 0; color: #6b7280; font-size: 14px; line-height: 1.6;">
                If the button doesn't work, copy and paste this link into your browser:<br/>
                <a href="${inviteUrl}" style="color: #0d72ff; word-break: break-all;">${inviteUrl}</a>
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 30px 40px 40px; background-color: #ffffff; border-radius: 0 0 12px 12px; border-top: 1px solid #e5e7eb;">
              <table role="presentation" style="width: 100%; border-collapse: collapse;">
                <tr>
                  <td align="center" style="padding: 0 0 8px;">
                    <p style="margin: 0; color: #1f2937; font-size: 18px; font-weight: 600; letter-spacing: -0.3px;">Otopair</p>
                  </td>
                </tr>
                <tr>
                  <td align="center" style="padding: 0 0 16px;">
                    <p style="margin: 0; color: #6b7280; font-size: 14px; line-height: 1.5;">The future of car repair coordination</p>
                  </td>
                </tr>
                <tr>
                  <td align="center">
                    <p style="margin: 0; color: #9ca3af; font-size: 12px; line-height: 1.6;">© Otopair ${new Date().getFullYear()}</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
      `,
    });

    return { success: true, data: result };
  } catch (error) {
    console.error('Error sending invite email:', error);
    return { success: false, error };
  }
}

interface WaitlistSignupData {
    email: string;
    name?: string;
}

/**
 * Send welcome email to user who joined waitlist
 */
export async function sendWaitlistConfirmationEmail(data: WaitlistSignupData) {
    try {
        const { email, name } = data;

        const result = await resend.emails.send({
            from: 'Otopair <onboarding@resend.dev>', // Update with your verified domain
            to: email,
            subject: 'Welcome to Otopair - You\'re on the Waitlist! 🚗',
            html: `
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Welcome to Otopair</title>
        </head>
        <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f9fafb;">
          <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #f9fafb;">
            <tr>
              <td align="center" style="padding: 40px 20px;">
                <table role="presentation" style="max-width: 600px; width: 100%; border-collapse: collapse; background-color: #ffffff; border-radius: 12px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
                  <!-- Header -->
                  <tr>
                    <td style="padding: 40px 40px 30px; text-align: center; background: linear-gradient(135deg, #0d72ff 0%, #3b82f6 100%); border-radius: 12px 12px 0 0;">
                      <h1 style="margin: 0; color: #ffffff; font-size: 32px; font-weight: 700; letter-spacing: -0.5px;">Welcome to Otopair!</h1>
                    </td>
                  </tr>
                  
                  <!-- Content -->
                  <tr>
                    <td style="padding: 40px;">
                      <p style="margin: 0 0 20px; color: #1f2937; font-size: 16px; line-height: 1.6;">
                        ${name ? `Hi ${name},` : 'Hi there,'}
                      </p>
                      
                      <p style="margin: 0 0 20px; color: #1f2937; font-size: 16px; line-height: 1.6;">
                        Thank you for joining the Otopair waitlist! We're thrilled to have you on board as we revolutionize the way car repairs are coordinated.
                      </p>
                      
                      <p style="margin: 0 0 20px; color: #1f2937; font-size: 16px; line-height: 1.6;">
                        <strong>What's next?</strong>
                      </p>
                      
                      <ul style="margin: 0 0 20px; padding-left: 20px; color: #1f2937; font-size: 16px; line-height: 1.8;">
                        <li>You'll be among the first to access our beta when it launches</li>
                        <li>Receive exclusive updates on new features and improvements</li>
                        <li>Get early access to special offers and promotions</li>
                        <li>Help shape the future of car repair coordination</li>
                      </ul>
                      
                      <p style="margin: 0 0 20px; color: #1f2937; font-size: 16px; line-height: 1.6;">
                        We're building something special, and your support means everything to us. Stay tuned for exciting updates!
                      </p>
                      
                      <!-- CTA Button -->
                      <table role="presentation" style="width: 100%; border-collapse: collapse; margin: 30px 0;">
                        <tr>
                          <td align="center" style="padding: 0;">
                            <a href="https://otopair.com" style="display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #0d72ff 0%, #3b82f6 100%); color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px; box-shadow: 0 4px 14px rgba(13, 114, 255, 0.3);">
                              Visit Otopair
                            </a>
                          </td>
                        </tr>
                      </table>
                      
                      <p style="margin: 30px 0 0; color: #6b7280; font-size: 14px; line-height: 1.6;">
                        If you have any questions, feel free to reach out to us. We're here to help!
                      </p>
                    </td>
                  </tr>
                  
                  <!-- Footer -->
                  <tr>
                    <td style="padding: 50px 40px 40px; background-color: #ffffff; border-radius: 0 0 12px 12px; border-top: 1px solid #e5e7eb;">
                      <table role="presentation" style="width: 100%; border-collapse: collapse;">
                        <!-- Logo -->
                        <tr>
                          <td align="center" style="padding: 0 0 24px;">
                            <img src="https://otopair.com/logo.png" alt="Otopair Logo" style="width: 64px; height: 64px; display: block; margin: 0 auto;" />
                          </td>
                        </tr>
                        
                        <!-- Company Name -->
                        <tr>
                          <td align="center" style="padding: 0 0 8px;">
                            <p style="margin: 0; color: #1f2937; font-size: 18px; font-weight: 600; letter-spacing: -0.3px;">
                              Otopair
                            </p>
                          </td>
                        </tr>
                        
                        <!-- Tagline -->
                        <tr>
                          <td align="center" style="padding: 0 0 24px;">
                            <p style="margin: 0; color: #6b7280; font-size: 14px; line-height: 1.5;">
                              The future of car repair coordination
                            </p>
                          </td>
                        </tr>
                        
                        <!-- Social Links -->
                        <tr>
                          <td align="center" style="padding: 0 0 32px;">
                            <table role="presentation" style="border-collapse: collapse; margin: 0 auto;">
                              <tr>
                                <td style="padding: 0 6px;">
                                  <a href="https://www.linkedin.com/company/repair-connect/" target="_blank" rel="noopener noreferrer" style="display: inline-block; width: 40px; height: 40px; border: 1px solid #e5e7eb; border-radius: 8px; background-color: #ffffff; text-align: center; line-height: 40px; text-decoration: none; transition: background-color 0.2s;">
                                    <svg width="20" height="20" viewBox="0 0 24 24" fill="black" style="vertical-align: middle;">
                                      <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/>
                                    </svg>
                                  </a>
                                </td>
                              </tr>
                            </table>
                          </td>
                        </tr>
                        
                        <!-- Copyright -->
                        <tr>
                          <td align="center" style="padding: 0;">
                            <p style="margin: 0; color: #9ca3af; font-size: 12px; line-height: 1.6;">
                              © Otopair ${new Date().getFullYear()}
                            </p>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </body>
        </html>
      `,
        });

        return { success: true, data: result };
    } catch (error) {
        console.error('Error sending waitlist confirmation email:', error);
        return { success: false, error };
    }
}

type WalkinPayload = {
  shopName?: string | null;
  scheduledDate?: string | null;
  scheduledTime?: string | null;
  primaryService?: string | null;
  totalCost?: number | null;
  firstName?: string | null;
  vehicleSummary?: string | null;
  // Final-receipt extras (populated only for walkin_completed_claim).
  vin?: string | null;
  vehicleYear?: number | null;
  vehicleMake?: string | null;
  vehicleModel?: string | null;
  vehicleTrim?: string | null;
  vehicleImageUrl?: string | null;
  mechanicName?: string | null;
  services?: Array<{ name: string }>;
  partsUsed?: Array<{
    part_name?: string | null;
    brand?: string | null;
    oem_number?: string | null;
    cost?: number | null;
  }>;
  laborCost?: number | null;
  partsCost?: number | null;
  actualDurationMinutes?: number | null;
  completedDate?: string | null;
};

const OTOPAIR_LOGO_URL = "https://otopair.com/logo.png";
const BRAND_GRADIENT =
  "linear-gradient(135deg,#0d72ff 0%,#3b82f6 100%)";

function formatUSD(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(Number(n))) return null;
  return `$${Number(n).toFixed(2)}`;
}

function escapeHtml(s: string | null | undefined): string {
  if (!s) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatCompletedDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

type WalkinCategory =
  | "walkin_booking_confirmed"
  | "walkin_vehicle_at_shop"
  | "walkin_prejob_complete"
  | "walkin_completed_claim"
  | "appointment_reminder";

function brandedShell(headline: string, bodyHtml: string): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f9fafb;">
  <table role="presentation" style="width:100%;border-collapse:collapse;background:#f9fafb;">
    <tr><td align="center" style="padding:40px 20px;">
      <table role="presentation" style="max-width:600px;width:100%;border-collapse:collapse;background:#fff;border-radius:12px;box-shadow:0 4px 6px rgba(0,0,0,0.08);">
        <tr><td style="padding:32px 40px;text-align:center;background:linear-gradient(135deg,#0d72ff 0%,#3b82f6 100%);border-radius:12px 12px 0 0;">
          <h1 style="margin:0;color:#fff;font-size:22px;font-weight:700;letter-spacing:-0.3px;">${headline}</h1>
        </td></tr>
        <tr><td style="padding:32px 40px;color:#1f2937;font-size:16px;line-height:1.6;">${bodyHtml}</td></tr>
        <tr><td style="padding:24px 40px 32px;border-top:1px solid #e5e7eb;text-align:center;">
          <p style="margin:0;color:#1f2937;font-size:14px;font-weight:600;">Powered by Otopair</p>
          <p style="margin:4px 0 0;color:#9ca3af;font-size:12px;">© Otopair ${new Date().getFullYear()}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

const EMAIL_SUBJECTS: Record<WalkinCategory, (p: WalkinPayload) => string> = {
  walkin_booking_confirmed: (p) =>
    `You're booked at ${p.shopName ?? "your shop"}`,
  walkin_vehicle_at_shop: (p) =>
    `${p.shopName ?? "Your shop"} has your vehicle`,
  walkin_prejob_complete: (p) =>
    `Service starting at ${p.shopName ?? "your shop"}`,
  walkin_completed_claim: (p) =>
    `Your service at ${p.shopName ?? "your shop"} is complete`,
  appointment_reminder: (p) =>
    `Reminder: your appointment at ${p.shopName ?? "your shop"}`,
};

function renderMidJobBody(category: WalkinCategory, p: WalkinPayload): string {
  const shop = p.shopName ?? "your shop";
  const hi = p.firstName ? `Hi ${p.firstName},` : "Hi there,";
  switch (category) {
    case "walkin_booking_confirmed": {
      const when = p.scheduledDate && p.scheduledTime
        ? `${p.scheduledDate} at ${p.scheduledTime}`
        : "your scheduled time";
      return `<p>${hi}</p><p>You're booked at <strong>${shop}</strong> for <strong>${when}</strong>. We'll email you again when work starts.</p>`;
    }
    case "walkin_vehicle_at_shop":
      return `<p>${hi}</p><p><strong>${shop}</strong> has received your vehicle. We'll let you know the moment service begins.</p>`;
    case "walkin_prejob_complete": {
      const svc = p.primaryService ?? "service";
      return `<p>${hi}</p><p>Inspection complete at <strong>${shop}</strong>. Starting your <strong>${svc}</strong> now.</p>`;
    }
    case "appointment_reminder": {
      const when = p.scheduledDate && p.scheduledTime
        ? `${p.scheduledDate} at ${p.scheduledTime}`
        : "your scheduled time";
      const svcLine = p.primaryService
        ? `<p>Service: <strong>${p.primaryService}</strong>.</p>`
        : "";
      return `<p>${hi}</p><p>This is a friendly reminder that your appointment at <strong>${shop}</strong> is <strong>${when}</strong>.</p>${svcLine}<p>Need to reschedule? Just reply to this email and we'll take care of it.</p>`;
    }
    default:
      return `<p>${hi}</p><p>Update from <strong>${shop}</strong>.</p>`;
  }
}

/**
 * Mid-job email update (categories 1–3). Carries no claim CTA.
 */
export async function sendBookingUpdateEmail({
  to,
  category,
  payload,
}: {
  to: string;
  category: WalkinCategory;
  payload: WalkinPayload;
}) {
  try {
    const subject = EMAIL_SUBJECTS[category](payload);
    const html = brandedShell(subject, renderMidJobBody(category, payload));
    const result = await resend.emails.send({
      from: "Otopair <info@otopair.com>",
      to,
      subject,
      html,
    });
    return { success: true, data: result };
  } catch (error) {
    console.error("Error sending booking update email:", error);
    return { success: false, error };
  }
}

function renderVehicleTitle(p: WalkinPayload): string {
  const parts = [p.vehicleYear, p.vehicleMake, p.vehicleModel, p.vehicleTrim]
    .filter((x): x is string | number => x != null && x !== "")
    .map((x) => escapeHtml(String(x)));
  return parts.join(" ");
}

function renderHeroImage(url: string | null | undefined): string {
  if (!url) return "";
  return `
    <table role="presentation" style="width:100%;border-collapse:collapse;margin:8px 0 24px;">
      <tr><td style="background:linear-gradient(135deg,#f3f4f6,#e5e7eb);border-radius:12px;padding:24px;text-align:center;">
        <img src="${escapeHtml(url)}" alt="Your vehicle"
             style="display:inline-block;max-width:100%;height:200px;object-fit:contain;" />
      </td></tr>
    </table>`;
}

function renderSummaryRow(label: string, value: string | null): string {
  if (!value) return "";
  return `
    <tr>
      <td style="padding:6px 0;color:#6b7280;font-size:14px;width:120px;">${escapeHtml(label)}</td>
      <td style="padding:6px 0;color:#111827;font-size:14px;font-weight:500;">${value}</td>
    </tr>`;
}

function renderSummaryCard(p: WalkinPayload): string {
  const rows = [
    renderSummaryRow("Mechanic", escapeHtml(p.mechanicName ?? null) || null),
    renderSummaryRow("Completed", escapeHtml(formatCompletedDate(p.completedDate))),
    renderSummaryRow(
      "Duration",
      p.actualDurationMinutes != null
        ? `${Math.round(Number(p.actualDurationMinutes))} min`
        : null,
    ),
  ]
    .filter(Boolean)
    .join("");
  if (!rows) return "";
  return `
    <p style="margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#6b7280;">Service summary</p>
    <table role="presentation" style="width:100%;border-collapse:collapse;margin:0 0 24px;">${rows}</table>`;
}

function renderServicesList(services: Array<{ name: string }> | undefined): string {
  if (!services || services.length === 0) return "";
  const items = services
    .map(
      (s) =>
        `<li style="padding:4px 0;color:#111827;font-size:14px;">${escapeHtml(s.name)}</li>`,
    )
    .join("");
  return `
    <p style="margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#6b7280;">Services performed</p>
    <ul style="margin:0 0 24px;padding-left:20px;">${items}</ul>`;
}

function renderPartsTable(parts: WalkinPayload["partsUsed"]): string {
  if (!parts || parts.length === 0) return "";
  const rows = parts
    .map((p) => {
      const name = escapeHtml(p.part_name) || "—";
      const brand = p.brand ? `<div style="color:#6b7280;font-size:12px;">${escapeHtml(p.brand)}</div>` : "";
      const oem = p.oem_number ? escapeHtml(p.oem_number) : "";
      const cost = formatUSD(p.cost ?? null) ?? "";
      return `
        <tr>
          <td style="padding:8px 12px;border-top:1px solid #e5e7eb;color:#111827;font-size:14px;">
            ${name}${brand}
          </td>
          <td style="padding:8px 12px;border-top:1px solid #e5e7eb;color:#6b7280;font-size:13px;font-family:'SF Mono',Menlo,monospace;">${oem}</td>
          <td style="padding:8px 12px;border-top:1px solid #e5e7eb;color:#111827;font-size:14px;text-align:right;">${cost}</td>
        </tr>`;
    })
    .join("");
  return `
    <p style="margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#6b7280;">Parts used</p>
    <table role="presentation" style="width:100%;border-collapse:collapse;margin:0 0 24px;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
      <thead>
        <tr style="background:#f9fafb;">
          <th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;">Part</th>
          <th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;">OEM #</th>
          <th style="padding:8px 12px;text-align:right;font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;">Cost</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderCostBreakdown(p: WalkinPayload): string {
  const labor = formatUSD(p.laborCost ?? null);
  const parts = formatUSD(p.partsCost ?? null);
  const total = formatUSD(p.totalCost ?? null);
  if (!labor && !parts && !total) return "";
  const row = (label: string, value: string | null) =>
    value
      ? `<tr><td style="padding:6px 0;color:#6b7280;font-size:14px;">${escapeHtml(label)}</td><td style="padding:6px 0;color:#111827;font-size:14px;text-align:right;">${value}</td></tr>`
      : "";
  const totalRow = total
    ? `<tr><td style="padding:12px 0 0;color:#111827;font-size:16px;font-weight:700;border-top:2px solid #111827;">Total</td><td style="padding:12px 0 0;color:#111827;font-size:18px;font-weight:700;text-align:right;border-top:2px solid #111827;">${total}</td></tr>`
    : "";
  return `
    <table role="presentation" style="width:100%;border-collapse:collapse;margin:0 0 24px;">
      ${row("Labor", labor)}
      ${row("Parts", parts)}
      ${totalRow}
    </table>`;
}

function renderClaimCta(claimUrl: string | null, shop: string): string {
  if (!claimUrl) {
    return `<p style="margin:24px 0 0;color:#6b7280;font-size:14px;">Thanks for choosing ${escapeHtml(shop)}.</p>`;
  }
  return `
    <table role="presentation" style="width:100%;border-collapse:collapse;margin:24px 0 8px;">
      <tr><td align="center">
        <a href="${escapeHtml(claimUrl)}"
           style="display:inline-block;padding:14px 32px;background:${BRAND_GRADIENT};color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:16px;box-shadow:0 4px 14px rgba(13,114,255,0.3);">
          Claim your Otopair account
        </a>
      </td></tr>
    </table>
    <p style="margin:8px 0 0;color:#6b7280;font-size:14px;text-align:center;">
      Your service history &amp; vehicle are already saved — sign up to book faster next time.
    </p>`;
}

/**
 * Branded shell with logo header. Used by the final post-job email.
 */
function brandedShellWithLogo(headline: string, bodyHtml: string): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f9fafb;">
  <table role="presentation" style="width:100%;border-collapse:collapse;background:#f9fafb;">
    <tr><td align="center" style="padding:40px 20px;">
      <table role="presentation" style="max-width:600px;width:100%;border-collapse:collapse;background:#fff;border-radius:12px;box-shadow:0 4px 6px rgba(0,0,0,0.08);overflow:hidden;">
        <tr><td style="padding:36px 40px 28px;text-align:center;background:${BRAND_GRADIENT};">
          <img src="${OTOPAIR_LOGO_URL}" alt="Otopair" width="48" height="48" style="display:inline-block;margin:0 auto 12px;border:0;" />
          <h1 style="margin:0;color:#fff;font-size:22px;font-weight:700;letter-spacing:-0.3px;">${escapeHtml(headline)}</h1>
        </td></tr>
        <tr><td style="padding:32px 40px;color:#1f2937;font-size:16px;line-height:1.6;">${bodyHtml}</td></tr>
        <tr><td style="padding:24px 40px 32px;border-top:1px solid #e5e7eb;text-align:center;background:#fafafa;">
          <p style="margin:0;color:#1f2937;font-size:14px;font-weight:600;">Powered by Otopair</p>
          <p style="margin:4px 0 0;color:#9ca3af;font-size:12px;">© Otopair ${new Date().getFullYear()}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

/**
 * Final post-job email — itemized receipt + claim CTA. When claimUrl is
 * null (user already claimed), the CTA falls back to a plain thank-you;
 * the rest of the receipt still renders.
 */
export async function sendWalkinClaimEmail({
  to,
  payload,
  claimUrl,
}: {
  to: string;
  payload: WalkinPayload;
  claimUrl: string | null;
}) {
  try {
    const shop = payload.shopName ?? "your shop";
    const hi = payload.firstName ? `Hi ${escapeHtml(payload.firstName)},` : "Hi there,";
    const vehicleTitle = renderVehicleTitle(payload);
    const lede = vehicleTitle
      ? `Your <strong>${vehicleTitle}</strong> is ready.`
      : "Your service is complete.";

    const body = `
      <p style="margin:0 0 8px;">${hi}</p>
      <p style="margin:0 0 24px;">${lede}</p>
      ${renderHeroImage(payload.vehicleImageUrl)}
      ${renderSummaryCard(payload)}
      ${renderServicesList(payload.services)}
      ${renderPartsTable(payload.partsUsed)}
      ${renderCostBreakdown(payload)}
      ${renderClaimCta(claimUrl, shop)}
    `;
    const html = brandedShellWithLogo(`Service complete at ${shop}`, body);

    const result = await resend.emails.send({
      from: "Otopair <info@otopair.com>",
      to,
      subject: `Service complete at ${shop}`,
      html,
    });
    return { success: true, data: result };
  } catch (error) {
    console.error("Error sending walk-in claim email:", error);
    return { success: false, error };
  }
}

/**
 * Receipt / invoice email — sent after Stripe capture succeeds with the
 * branded PDF attached. Both the inline HTML and the attachment carry the
 * same invoice number so support can match them up.
 */
export async function sendInvoiceEmail({
  to,
  invoiceNumber,
  customerFirstName,
  shopName,
  totalCents,
  status,
  pdfBase64,
  pdfFilename,
  receiptUrl,
}: {
  to: string;
  invoiceNumber: string;
  customerFirstName: string | null;
  shopName: string;
  totalCents: number;
  status: "paid" | "refunded";
  pdfBase64: string;
  pdfFilename: string;
  receiptUrl: string | null;
}) {
  try {
    const hi = customerFirstName ? `Hi ${escapeHtml(customerFirstName)},` : "Hi there,";
    const totalLabel = `$${(Math.max(0, totalCents) / 100).toFixed(2)}`;
    const subjectVerb = status === "refunded" ? "Refund processed" : "Receipt";
    const headline =
      status === "refunded"
        ? "Your refund has been processed"
        : "Thanks for your payment";
    const lede =
      status === "refunded"
        ? `Your ${totalLabel} payment to <strong>${escapeHtml(shopName)}</strong> has been refunded. An updated invoice (<strong>${escapeHtml(invoiceNumber)}</strong>) is attached for your records.`
        : `Your <strong>${totalLabel}</strong> payment to <strong>${escapeHtml(shopName)}</strong> went through. We've attached invoice <strong>${escapeHtml(invoiceNumber)}</strong> as a PDF for your records.`;

    const onlineCta = receiptUrl
      ? `
      <table role="presentation" style="width:100%;border-collapse:collapse;margin:0 0 24px;">
        <tr><td align="center">
          <a href="${escapeHtml(receiptUrl)}"
             style="display:inline-block;padding:14px 32px;background:${BRAND_GRADIENT};color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:15px;box-shadow:0 4px 14px rgba(13,114,255,0.3);">
            View receipt online
          </a>
        </td></tr>
      </table>
      <p style="margin:0 0 24px;color:#6b7280;font-size:13px;text-align:center;">
        Or download the PDF attached to this email.
      </p>`
      : "";

    const body = `
      <p style="margin:0 0 8px;">${hi}</p>
      <p style="margin:0 0 24px;">${lede}</p>
      <table role="presentation" style="width:100%;border-collapse:collapse;margin:0 0 24px;background:#f9fafb;border-radius:8px;border:1px solid #e5e7eb;">
        <tr>
          <td style="padding:16px 20px;">
            <p style="margin:0 0 4px;color:#6b7280;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;">Invoice</p>
            <p style="margin:0;color:#111827;font-size:16px;font-weight:600;">${escapeHtml(invoiceNumber)}</p>
          </td>
          <td align="right" style="padding:16px 20px;">
            <p style="margin:0 0 4px;color:#6b7280;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;">${status === "refunded" ? "Refunded" : "Total"}</p>
            <p style="margin:0;color:#111827;font-size:18px;font-weight:700;">${totalLabel}</p>
          </td>
        </tr>
      </table>
      ${onlineCta}
      <p style="margin:0 0 8px;color:#6b7280;font-size:14px;">Need help with this charge? Reply to this email and our team will take a look.</p>
    `;
    const html = brandedShellWithLogo(
      `${subjectVerb} from ${shopName}`,
      body,
    );

    const result = await resend.emails.send({
      from: "Otopair <info@otopair.com>",
      to,
      subject: `${subjectVerb} ${invoiceNumber} · ${shopName}`,
      html,
      attachments: [
        {
          filename: pdfFilename,
          content: pdfBase64,
        },
      ],
    });
    return { success: true, data: result };
  } catch (error) {
    console.error("Error sending invoice email:", error);
    return { success: false, error };
  }
}

interface ShopApplicationData {
  ownerFullName: string;
  shopLegalName: string;
  businessEmail: string;
  phone: string;
  streetAddress: string;
}

/**
 * Confirmation receipt to a shop that applied to partner with Otopair (Step 1
 * of the invite-based onboarding flow). Carries NO claim token / CTA — it only
 * sets the expectation that the application is under review and, if approved, a
 * private invite follows. Uses the verified `info@otopair.com` sender.
 */
export async function sendShopApplicationReceiptEmail(data: ShopApplicationData) {
  try {
    const first = escapeHtml(data.ownerFullName.trim().split(/\s+/)[0] || "there");
    const body = `
      <p style="margin:0 0 8px;">Hi ${first},</p>
      <p style="margin:0 0 20px;">Thanks for applying to join Otopair as a partner shop.
      We've received your application for <strong>${escapeHtml(data.shopLegalName)}</strong>
      and our team is reviewing it now.</p>
      <table role="presentation" style="width:100%;border-collapse:collapse;margin:0 0 20px;background:#f9fafb;border-radius:8px;border:1px solid #e5e7eb;">
        <tr><td style="padding:16px 20px;">
          <p style="margin:0 0 4px;color:#6b7280;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;">Application summary</p>
          <p style="margin:8px 0 0;color:#111827;font-size:14px;font-weight:600;">${escapeHtml(data.shopLegalName)}</p>
          <p style="margin:2px 0 0;color:#6b7280;font-size:13px;">${escapeHtml(data.streetAddress)}</p>
        </td></tr>
      </table>
      <p style="margin:0 0 8px;color:#6b7280;font-size:14px;">
        No action needed right now — if approved, we'll email you a private invite to set up your shop.</p>`;
    const result = await resend.emails.send({
      from: "Otopair <info@otopair.com>",
      to: data.businessEmail,
      subject: "We received your Otopair partner application",
      html: brandedShell("Application received", body),
    });
    return { success: true, data: result };
  } catch (error) {
    console.error("Error sending shop application receipt email:", error);
    return { success: false, error };
  }
}

/**
 * Internal alert to the Otopair team when a new partner application lands.
 * Best-effort (mirrors the waitlist notification); never blocks the applicant
 * response. Goes to COMPANY_EMAIL (defaults to team@otopair.com).
 */
export async function sendShopApplicationNotificationEmail(data: ShopApplicationData) {
  try {
    const companyEmail = process.env.COMPANY_EMAIL || "team@otopair.com";
    const body = `
      <p style="margin:0 0 16px;">New partner-shop application submitted.</p>
      <table role="presentation" style="width:100%;border-collapse:collapse;background:#f9fafb;border-radius:8px;border:1px solid #e5e7eb;">
        <tr><td style="padding:20px;">
          <p style="margin:0 0 6px;font-size:13px;color:#111827;"><strong>Shop:</strong> ${escapeHtml(data.shopLegalName)}</p>
          <p style="margin:0 0 6px;font-size:13px;color:#111827;"><strong>Owner:</strong> ${escapeHtml(data.ownerFullName)}</p>
          <p style="margin:0 0 6px;font-size:13px;color:#111827;"><strong>Email:</strong> ${escapeHtml(data.businessEmail)}</p>
          <p style="margin:0 0 6px;font-size:13px;color:#111827;"><strong>Phone:</strong> ${escapeHtml(data.phone)}</p>
          <p style="margin:0;font-size:13px;color:#111827;"><strong>Address:</strong> ${escapeHtml(data.streetAddress)}</p>
        </td></tr>
      </table>`;
    const result = await resend.emails.send({
      from: "Otopair <info@otopair.com>",
      to: companyEmail,
      subject: `New partner application: ${data.shopLegalName}`,
      html: brandedShell("New partner application", body),
    });
    return { success: true, data: result };
  } catch (error) {
    console.error("Error sending shop application notification email:", error);
    return { success: false, error };
  }
}

/**
 * Branded invite to a shop owner whose application was approved (Step 2 of the
 * invite-based onboarding). The link carries a one-time 32-byte token (only its
 * hash is stored server-side) and expires in 7 days.
 */
export async function sendShopOwnerInviteEmail({
  email,
  inviteUrl,
  shopName,
  ownerName,
}: {
  email: string;
  inviteUrl: string;
  shopName: string;
  ownerName?: string;
}) {
  try {
    const hi = ownerName ? `Hi ${escapeHtml(ownerName.trim().split(/\s+/)[0])},` : "Hi there,";
    const body = `
      <p style="margin:0 0 8px;">${hi}</p>
      <p style="margin:0 0 24px;">Good news — your application to partner with Otopair has been
      approved. You can now claim <strong>${escapeHtml(shopName)}</strong> and set up your shop as
      the <strong>Shop Owner</strong>.</p>
      <table role="presentation" style="width:100%;border-collapse:collapse;margin:0 0 8px;">
        <tr><td align="center">
          <a href="${escapeHtml(inviteUrl)}"
             style="display:inline-block;padding:14px 32px;background:${BRAND_GRADIENT};color:#fff;text-decoration:none;border-radius:8px;font-weight:600;font-size:16px;box-shadow:0 4px 14px rgba(13,114,255,0.3);">
            Claim your shop
          </a>
        </td></tr>
      </table>
      <p style="margin:16px 0 0;color:#6b7280;font-size:13px;text-align:center;">
        This link is unique to you and expires in 7 days.</p>
      <p style="margin:20px 0 0;color:#6b7280;font-size:14px;line-height:1.6;">
        If the button doesn't work, copy and paste this link into your browser:<br/>
        <a href="${escapeHtml(inviteUrl)}" style="color:#0d72ff;word-break:break-all;">${escapeHtml(inviteUrl)}</a>
      </p>`;
    const result = await resend.emails.send({
      from: "Otopair <info@otopair.com>",
      to: email,
      subject: `You're approved — claim ${shopName} on Otopair`,
      html: brandedShellWithLogo("You're approved", body),
    });
    return { success: true, data: result };
  } catch (error) {
    console.error("Error sending shop owner invite email:", error);
    return { success: false, error };
  }
}

/**
 * Send notification email to company when someone joins waitlist
 */
export async function sendWaitlistNotificationEmail(data: WaitlistSignupData) {
    try {
        const { email, name } = data;
        const companyEmail = process.env.COMPANY_EMAIL || 'team@otopair.com'; // Update with your company email

        const result = await resend.emails.send({
            from: 'Otopair <onboarding@resend.dev>', // Update with your verified domain
            to: companyEmail,
            subject: `🎉 New Waitlist Signup: ${email}`,
            html: `
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>New Waitlist Signup</title>
        </head>
        <body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f9fafb;">
          <table role="presentation" style="width: 100%; border-collapse: collapse; background-color: #f9fafb;">
            <tr>
              <td align="center" style="padding: 40px 20px;">
                <table role="presentation" style="max-width: 600px; width: 100%; border-collapse: collapse; background-color: #ffffff; border-radius: 12px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
                  <!-- Header -->
                  <tr>
                    <td style="padding: 30px 40px; text-align: center; background: linear-gradient(135deg, #10b981 0%, #059669 100%); border-radius: 12px 12px 0 0;">
                      <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 700; letter-spacing: -0.5px;">New Waitlist Signup! 🎉</h1>
                    </td>
                  </tr>
                  
                  <!-- Content -->
                  <tr>
                    <td style="padding: 40px;">
                      <p style="margin: 0 0 20px; color: #1f2937; font-size: 16px; line-height: 1.6;">
                        Great news! Someone new has joined the Otopair waitlist.
                      </p>
                      
                      <!-- User Info Card -->
                      <table role="presentation" style="width: 100%; border-collapse: collapse; margin: 20px 0; background-color: #f9fafb; border-radius: 8px; border: 1px solid #e5e7eb;">
                        <tr>
                          <td style="padding: 20px;">
                            <table role="presentation" style="width: 100%; border-collapse: collapse;">
                              <tr>
                                <td style="padding: 0 0 12px; color: #6b7280; font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">
                                  Email Address
                                </td>
                              </tr>
                              <tr>
                                <td style="padding: 0 0 20px; color: #1f2937; font-size: 18px; font-weight: 600;">
                                  ${email}
                                </td>
                              </tr>
                              ${name ? `
                              <tr>
                                <td style="padding: 0 0 12px; color: #6b7280; font-size: 14px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">
                                  Name
                                </td>
                              </tr>
                              <tr>
                                <td style="padding: 0; color: #1f2937; font-size: 18px; font-weight: 600;">
                                  ${name}
                                </td>
                              </tr>
                              ` : ''}
                            </table>
                          </td>
                        </tr>
                      </table>
                      
                      <p style="margin: 20px 0 0; color: #6b7280; font-size: 14px; line-height: 1.6;">
                        <strong>Timestamp:</strong> ${new Date().toLocaleString('en-US', {
                weekday: 'long',
                year: 'numeric',
                month: 'long',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
                timeZoneName: 'short'
            })}
                      </p>
                    </td>
                  </tr>
                  
                  <!-- Footer -->
                  <tr>
                    <td style="padding: 50px 40px 40px; background-color: #ffffff; border-radius: 0 0 12px 12px; border-top: 1px solid #e5e7eb;">
                      <table role="presentation" style="width: 100%; border-collapse: collapse;">
                        <!-- Logo -->
                        <tr>
                          <td align="center" style="padding: 0 0 24px;">
                            <img src="https://otopair.com/logo.png" alt="Otopair Logo" style="width: 64px; height: 64px; display: block; margin: 0 auto;" />
                          </td>
                        </tr>
                        
                        <!-- Company Name -->
                        <tr>
                          <td align="center" style="padding: 0 0 8px;">
                            <p style="margin: 0; color: #1f2937; font-size: 18px; font-weight: 600; letter-spacing: -0.3px;">
                              Otopair
                            </p>
                          </td>
                        </tr>
                        
                        <!-- Tagline -->
                        <tr>
                          <td align="center" style="padding: 0 0 24px;">
                            <p style="margin: 0; color: #6b7280; font-size: 14px; line-height: 1.5;">
                              The future of car repair coordination
                            </p>
                          </td>
                        </tr>
                        
                        <!-- Social Links -->
                        <tr>
                          <td align="center" style="padding: 0 0 32px;">
                            <table role="presentation" style="border-collapse: collapse; margin: 0 auto;">
                              <tr>
                                <td style="padding: 0 6px;">
                                  <a href="https://www.linkedin.com/company/repair-connect/" target="_blank" rel="noopener noreferrer" style="display: inline-block; width: 40px; height: 40px; border: 1px solid #e5e7eb; border-radius: 8px; background-color: #ffffff; text-align: center; line-height: 40px; text-decoration: none; transition: background-color 0.2s;">
                                    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" style="vertical-align: middle; color: #1f2937;">
                                      <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/>
                                    </svg>
                                  </a>
                                </td>
                                <td style="padding: 0 6px;">
                                  <a href="https://twitter.com" target="_blank" rel="noopener noreferrer" style="display: inline-block; width: 40px; height: 40px; border: 1px solid #e5e7eb; border-radius: 8px; background-color: #ffffff; text-align: center; line-height: 40px; text-decoration: none; transition: background-color 0.2s;">
                                    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" style="vertical-align: middle; color: #1f2937;">
                                      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
                                    </svg>
                                  </a>
                                </td>
                              </tr>
                            </table>
                          </td>
                        </tr>
                        
                        <!-- Copyright -->
                        <tr>
                          <td align="center" style="padding: 0;">
                            <p style="margin: 0; color: #9ca3af; font-size: 12px; line-height: 1.6;">
                              © Otopair ${new Date().getFullYear()}
                            </p>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </body>
        </html>
      `,
        });

        return { success: true, data: result };
    } catch (error) {
        console.error('Error sending waitlist notification email:', error);
        return { success: false, error };
    }
}

// ============================================================================
// Support / dispute requests
// ============================================================================
//
// Customer-initiated "report an issue" mail from the Past Service detail
// screen. Lands in support@otopair.com (overridable via SUPPORT_EMAIL). The
// reply-to is set to the customer's email so ops can hit Reply and the
// thread goes straight back to them.
//
// Body is plain HTML — short header + the booking snapshot, the chosen
// reason, the customer note, then a footer. Keep this lean: the receiving
// inbox is internal, not a marketing surface.
export interface SupportRequestEmailData {
  /** Short reason slug picked in the sheet (e.g. "service_quality"). */
  reasonKey: string;
  /** Human-readable reason label shown to ops. */
  reasonLabel: string;
  /** User-supplied description of the issue. */
  message: string;
  /** Customer's email — used as reply-to so ops can respond directly. */
  customerEmail: string;
  /** Customer display name when we have it. */
  customerName?: string;
  /** Snapshot of the booking the issue is about. */
  booking: {
    id: string;
    orderNumber: string;
    shopName: string;
    mechanicName?: string;
    date?: string;
    time?: string;
    vehicle?: string;
    totalDollars?: number;
  };
}

export async function sendSupportRequestEmail(data: SupportRequestEmailData) {
  const supportInbox = process.env.SUPPORT_EMAIL || "support@otopair.com";
  const { reasonKey, reasonLabel, message, customerEmail, customerName, booking } = data;
  const safeMessage = (message || "").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const lineCss = "margin:0 0 6px;color:#1f2937;font-size:14px;line-height:1.5;";
  const labelCss = "color:#6b7280;font-weight:600;";

  const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head><meta charset="UTF-8"/><title>Otopair — support request</title></head>
    <body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background-color:#f9fafb;">
      <table role="presentation" style="width:100%;border-collapse:collapse;background-color:#f9fafb;">
        <tr><td align="center" style="padding:32px 16px;">
          <table role="presentation" style="max-width:560px;width:100%;border-collapse:collapse;background-color:#ffffff;border-radius:12px;box-shadow:0 4px 6px rgba(0,0,0,0.08);">
            <tr><td style="padding:24px 28px 8px;border-bottom:1px solid #e5e7eb;">
              <h1 style="margin:0;color:#0f172a;font-size:20px;font-weight:700;">New support request</h1>
              <p style="margin:4px 0 0;color:#6b7280;font-size:13px;">Filed from the Past Service detail screen.</p>
            </td></tr>
            <tr><td style="padding:20px 28px 4px;">
              <p style="${lineCss}"><span style="${labelCss}">Reason:</span> ${reasonLabel} <span style="color:#9ca3af;font-size:12px;">(${reasonKey})</span></p>
              <p style="${lineCss}"><span style="${labelCss}">From:</span> ${customerName ? `${customerName} ` : ""}&lt;${customerEmail}&gt;</p>
            </td></tr>
            <tr><td style="padding:8px 28px 4px;">
              <h2 style="margin:18px 0 8px;color:#0f172a;font-size:14px;text-transform:uppercase;letter-spacing:0.4px;">Booking</h2>
              <p style="${lineCss}"><span style="${labelCss}">Order:</span> #${booking.orderNumber}</p>
              <p style="${lineCss}"><span style="${labelCss}">Shop:</span> ${booking.shopName}</p>
              ${booking.mechanicName ? `<p style="${lineCss}"><span style="${labelCss}">Mechanic:</span> ${booking.mechanicName}</p>` : ""}
              ${booking.date ? `<p style="${lineCss}"><span style="${labelCss}">Date:</span> ${booking.date}${booking.time ? ` · ${booking.time}` : ""}</p>` : ""}
              ${booking.vehicle ? `<p style="${lineCss}"><span style="${labelCss}">Vehicle:</span> ${booking.vehicle}</p>` : ""}
              ${booking.totalDollars != null ? `<p style="${lineCss}"><span style="${labelCss}">Total:</span> $${booking.totalDollars.toFixed(2)}</p>` : ""}
              <p style="${lineCss}"><span style="${labelCss}">Internal booking id:</span> <code style="font-size:12px;color:#374151;">${booking.id}</code></p>
            </td></tr>
            <tr><td style="padding:8px 28px 24px;">
              <h2 style="margin:18px 0 8px;color:#0f172a;font-size:14px;text-transform:uppercase;letter-spacing:0.4px;">Message</h2>
              <div style="background-color:#f3f4f6;border-radius:8px;padding:12px 14px;color:#1f2937;font-size:14px;line-height:1.55;white-space:pre-wrap;">${safeMessage || "(no message provided)"}</div>
            </td></tr>
            <tr><td style="padding:0 28px 24px;color:#9ca3af;font-size:12px;line-height:1.4;">
              Reply to this email to respond to the customer directly.
            </td></tr>
          </table>
        </td></tr>
      </table>
    </body>
    </html>
  `;

  try {
    const result = await resend.emails.send({
      from: "Otopair Support <support@otopair.com>",
      to: supportInbox,
      replyTo: customerEmail,
      subject: `Support request · ${reasonLabel} · Order #${booking.orderNumber}`,
      html,
    });
    return { success: true, data: result };
  } catch (error) {
    console.error("Error sending support request email:", error);
    return { success: false, error };
  }
}

// ----------------------------------------------------------------------------
// Contact Support form (Settings → Contact Us). No booking context — just a
// topic, subject and description. Lands in support@otopair.com (overridable
// via SUPPORT_EMAIL), reply-to set to the customer so ops can hit Reply.
// ----------------------------------------------------------------------------
export interface ContactSupportEmailData {
  /** Topic label chosen in the sheet (e.g. "Bookings & services"). */
  topic: string;
  subject: string;
  description: string;
  /** Customer's email — used as reply-to. */
  customerEmail: string;
  customerName?: string;
  /** How many screenshots/videos the user attached (not uploaded here). */
  attachmentCount?: number;
}

export async function sendContactSupportEmail(data: ContactSupportEmailData) {
  const supportInbox = process.env.SUPPORT_EMAIL || "support@otopair.com";
  const { topic, subject, description, customerEmail, customerName, attachmentCount } = data;
  const esc = (s: string) => (s || "").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const lineCss = "margin:0 0 6px;color:#1f2937;font-size:14px;line-height:1.5;";
  const labelCss = "color:#6b7280;font-weight:600;";

  const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head><meta charset="UTF-8"/><title>Otopair — contact support</title></head>
    <body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background-color:#f9fafb;">
      <table role="presentation" style="width:100%;border-collapse:collapse;background-color:#f9fafb;">
        <tr><td align="center" style="padding:32px 16px;">
          <table role="presentation" style="max-width:560px;width:100%;border-collapse:collapse;background-color:#ffffff;border-radius:12px;box-shadow:0 4px 6px rgba(0,0,0,0.08);">
            <tr><td style="padding:24px 28px 8px;border-bottom:1px solid #e5e7eb;">
              <h1 style="margin:0;color:#0f172a;font-size:20px;font-weight:700;">New contact request</h1>
              <p style="margin:4px 0 0;color:#6b7280;font-size:13px;">Sent from Settings → Contact Us.</p>
            </td></tr>
            <tr><td style="padding:20px 28px 4px;">
              <p style="${lineCss}"><span style="${labelCss}">Topic:</span> ${esc(topic)}</p>
              <p style="${lineCss}"><span style="${labelCss}">Subject:</span> ${esc(subject)}</p>
              <p style="${lineCss}"><span style="${labelCss}">From:</span> ${customerName ? `${esc(customerName)} ` : ""}&lt;${esc(customerEmail)}&gt;</p>
              ${attachmentCount ? `<p style="${lineCss}"><span style="${labelCss}">Attachments:</span> ${attachmentCount} (ask the customer to resend if needed)</p>` : ""}
            </td></tr>
            <tr><td style="padding:8px 28px 24px;">
              <h2 style="margin:18px 0 8px;color:#0f172a;font-size:14px;text-transform:uppercase;letter-spacing:0.4px;">Message</h2>
              <div style="background-color:#f3f4f6;border-radius:8px;padding:12px 14px;color:#1f2937;font-size:14px;line-height:1.55;white-space:pre-wrap;">${esc(description) || "(no message provided)"}</div>
            </td></tr>
            <tr><td style="padding:0 28px 24px;color:#9ca3af;font-size:12px;line-height:1.4;">
              Reply to this email to respond to the customer directly.
            </td></tr>
          </table>
        </td></tr>
      </table>
    </body>
    </html>
  `;

  try {
    const result = await resend.emails.send({
      from: "Otopair Support <support@otopair.com>",
      to: supportInbox,
      replyTo: customerEmail,
      subject: `Contact · ${topic} · ${subject}`,
      html,
    });
    return { success: true, data: result };
  } catch (error) {
    console.error("Error sending contact support email:", error);
    return { success: false, error };
  }
}

// ----------------------------------------------------------------------------
// App feedback ("Give Us Feedback" modal). Emails the note to
// support@otopair.com; reply-to the user's email when we have it.
// ----------------------------------------------------------------------------
export interface FeedbackEmailData {
  text: string;
  source?: string;
  customerEmail?: string;
  customerName?: string;
}

export async function sendFeedbackEmail(data: FeedbackEmailData) {
  const supportInbox = process.env.SUPPORT_EMAIL || "support@otopair.com";
  const { text, source, customerEmail, customerName } = data;
  const esc = (s: string) => (s || "").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lineCss = "margin:0 0 6px;color:#1f2937;font-size:14px;line-height:1.5;";
  const labelCss = "color:#6b7280;font-weight:600;";
  const fromLine =
    customerEmail || customerName
      ? `<p style="${lineCss}"><span style="${labelCss}">From:</span> ${customerName ? `${esc(customerName)} ` : ""}${customerEmail ? `&lt;${esc(customerEmail)}&gt;` : ""}</p>`
      : "";
  const sourceLine = source
    ? `<p style="${lineCss}"><span style="${labelCss}">Source:</span> ${esc(source)}</p>`
    : "";

  const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head><meta charset="UTF-8"/><title>Otopair — app feedback</title></head>
    <body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background-color:#f9fafb;">
      <table role="presentation" style="width:100%;border-collapse:collapse;background-color:#f9fafb;">
        <tr><td align="center" style="padding:32px 16px;">
          <table role="presentation" style="max-width:560px;width:100%;border-collapse:collapse;background-color:#ffffff;border-radius:12px;box-shadow:0 4px 6px rgba(0,0,0,0.08);">
            <tr><td style="padding:24px 28px 8px;border-bottom:1px solid #e5e7eb;">
              <h1 style="margin:0;color:#0f172a;font-size:20px;font-weight:700;">New app feedback</h1>
              <p style="margin:4px 0 0;color:#6b7280;font-size:13px;">Sent from the “Give Us Feedback” form.</p>
            </td></tr>
            ${fromLine || sourceLine ? `<tr><td style="padding:20px 28px 4px;">${fromLine}${sourceLine}</td></tr>` : ""}
            <tr><td style="padding:8px 28px 24px;">
              <h2 style="margin:18px 0 8px;color:#0f172a;font-size:14px;text-transform:uppercase;letter-spacing:0.4px;">Feedback</h2>
              <div style="background-color:#f3f4f6;border-radius:8px;padding:12px 14px;color:#1f2937;font-size:14px;line-height:1.55;white-space:pre-wrap;">${esc(text) || "(empty)"}</div>
            </td></tr>
          </table>
        </td></tr>
      </table>
    </body>
    </html>
  `;

  try {
    const result = await resend.emails.send({
      from: "Otopair Support <support@otopair.com>",
      to: supportInbox,
      ...(customerEmail ? { replyTo: customerEmail } : {}),
      subject: `App feedback${source ? ` · ${source}` : ""}`,
      html,
    });
    return { success: true, data: result };
  } catch (error) {
    console.error("Error sending feedback email:", error);
    return { success: false, error };
  }
}

// ----------------------------------------------------------------------------
// Two-factor verification code. Sent to the user's own email; short-lived.
// ----------------------------------------------------------------------------
export async function sendTwoFactorEmail(data: { to: string; code: string; name?: string }) {
  const { to, code, name } = data;
  const greeting = name ? `Hi ${name.replace(/</g, "&lt;")},` : "Hi,";
  const spaced = String(code).split("").join(" ");

  const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head><meta charset="UTF-8"/><title>Your Otopair verification code</title></head>
    <body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background-color:#f9fafb;">
      <table role="presentation" style="width:100%;border-collapse:collapse;background-color:#f9fafb;">
        <tr><td align="center" style="padding:32px 16px;">
          <table role="presentation" style="max-width:480px;width:100%;border-collapse:collapse;background-color:#ffffff;border-radius:16px;box-shadow:0 4px 6px rgba(0,0,0,0.08);">
            <tr><td style="padding:32px 32px 8px;">
              <h1 style="margin:0;color:#0f172a;font-size:20px;font-weight:700;">Verification code</h1>
              <p style="margin:12px 0 0;color:#374151;font-size:14px;line-height:1.5;">${greeting}</p>
              <p style="margin:6px 0 0;color:#374151;font-size:14px;line-height:1.5;">Use this code to finish setting up two-factor authentication on your Otopair account.</p>
            </td></tr>
            <tr><td style="padding:24px 32px;">
              <div style="background-color:#eff6ff;border:1px solid #dbeafe;border-radius:12px;padding:20px;text-align:center;">
                <span style="color:#1d4ed8;font-size:34px;font-weight:800;letter-spacing:8px;">${spaced}</span>
              </div>
            </td></tr>
            <tr><td style="padding:0 32px 28px;color:#6b7280;font-size:13px;line-height:1.5;">
              This code expires in 5 minutes. If you didn't request it, you can safely ignore this email.
            </td></tr>
          </table>
        </td></tr>
      </table>
    </body>
    </html>
  `;

  try {
    const result = await resend.emails.send({
      from: "Otopair <info@otopair.com>",
      to,
      subject: `Your Otopair verification code: ${code}`,
      html,
    });
    return { success: true, data: result };
  } catch (error) {
    console.error("Error sending 2FA email:", error);
    return { success: false, error };
  }
}

/**
 * Confirmation receipt sent BACK to the customer after they submit a
 * support request. Pairs with `sendSupportRequestEmail` above — the
 * Node action sends both back-to-back so ops gets the inbox copy and
 * the user gets the "we got it" copy in the same submit.
 *
 * Kept short on purpose: a single confirmation card with the order
 * + reason snapshot and a "what to expect" line. No CTAs — they
 * just hit Reply if they want to follow up.
 */
export interface SupportRequestAckEmailData {
  /** Customer's email (the To: address). */
  customerEmail: string;
  /** Customer display name when we have it. */
  customerName?: string;
  /** Human-readable reason label shown on the receipt. */
  reasonLabel: string;
  /** Echo of the user's message so they can verify what we got. */
  message: string;
  booking: {
    orderNumber: string;
    shopName: string;
    date?: string;
    time?: string;
  };
}

export async function sendSupportRequestAckEmail(data: SupportRequestAckEmailData) {
  const { customerEmail, customerName, reasonLabel, message, booking } = data;
  const safeMessage = (message || "").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const greeting = customerName ? `Hi ${customerName.split(" ")[0]},` : "Hi there,";

  const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head><meta charset="UTF-8"/><title>Otopair — we got your report</title></head>
    <body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background-color:#f9fafb;">
      <table role="presentation" style="width:100%;border-collapse:collapse;background-color:#f9fafb;">
        <tr><td align="center" style="padding:32px 16px;">
          <table role="presentation" style="max-width:560px;width:100%;border-collapse:collapse;background-color:#ffffff;border-radius:12px;box-shadow:0 4px 6px rgba(0,0,0,0.08);">
            <tr><td style="padding:32px 28px 16px;text-align:center;background:linear-gradient(135deg,#5299FE 0%,#3b82f6 100%);border-radius:12px 12px 0 0;">
              <h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:700;">We've got your report</h1>
              <p style="margin:8px 0 0;color:rgba(255,255,255,0.9);font-size:13px;">Our support team will follow up by email.</p>
            </td></tr>
            <tr><td style="padding:24px 28px 4px;">
              <p style="margin:0 0 14px;color:#1f2937;font-size:15px;line-height:1.55;">${greeting}</p>
              <p style="margin:0 0 14px;color:#1f2937;font-size:15px;line-height:1.55;">
                Thanks for letting us know — we've received your message about
                <strong>Order #${booking.orderNumber}</strong> at
                <strong>${booking.shopName}</strong>${booking.date ? ` on ${booking.date}${booking.time ? ` at ${booking.time}` : ""}` : ""}.
              </p>
              <p style="margin:0 0 14px;color:#1f2937;font-size:15px;line-height:1.55;">
                Someone from our support team will reach out within
                <strong>one business day</strong>. You don't need to do
                anything in the meantime — if you'd like to add more
                context, just hit Reply to this email.
              </p>
            </td></tr>
            <tr><td style="padding:8px 28px 4px;">
              <h2 style="margin:18px 0 8px;color:#0f172a;font-size:13px;text-transform:uppercase;letter-spacing:0.5px;">What you sent us</h2>
              <p style="margin:0 0 8px;color:#374151;font-size:14px;line-height:1.5;"><strong style="color:#6b7280;font-weight:600;">Reason:</strong> ${reasonLabel}</p>
              <div style="background-color:#f3f4f6;border-radius:8px;padding:12px 14px;color:#1f2937;font-size:14px;line-height:1.55;white-space:pre-wrap;">${safeMessage || "(no message)"}</div>
            </td></tr>
            <tr><td style="padding:24px 28px;color:#9ca3af;font-size:12px;line-height:1.4;text-align:center;">
              You're getting this email because you reported an issue from your Otopair account.
            </td></tr>
          </table>
        </td></tr>
      </table>
    </body>
    </html>
  `;

  try {
    const result = await resend.emails.send({
      from: "Otopair Support <support@otopair.com>",
      to: customerEmail,
      subject: `We got your message about Order #${booking.orderNumber}`,
      html,
    });
    return { success: true, data: result };
  } catch (error) {
    console.error("Error sending support ack email:", error);
    return { success: false, error };
  }
}

