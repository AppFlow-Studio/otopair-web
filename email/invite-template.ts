// Pure, dependency-free builder for the team-invite email so the markup can be
// rendered/previewed in isolation (no Resend, no env). `email/send.ts` wraps
// this in the actual Resend send.

function esc(s: string | null | undefined): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function inviteRoleLabel(role?: string): string {
  switch (role) {
    case "shop_mechanic":
    case "mechanic":
      return "mechanic";
    case "front_desk":
      return "front desk";
    case "shop_owner":
    case "owner":
      return "shop owner";
    default:
      return "team member";
  }
}

export interface InviteEmailOptions {
  inviteUrl: string;
  shopName?: string;
  firstName?: string;
  role?: string;
  inviterName?: string;
  logoUrl: string;
  year: number;
}

export function renderInviteEmailHtml(opts: InviteEmailOptions): string {
  const { inviteUrl, shopName, firstName, role, inviterName, logoUrl, year } = opts;
  const roleLabel = inviteRoleLabel(role);
  const greetingName = firstName?.trim() ? esc(firstName.trim()) : "there";
  const shopLabel = shopName ? `<strong>${esc(shopName)}</strong>` : "a shop";
  const inviterLabel = inviterName?.trim() ? esc(inviterName.trim()) : "";

  const introLine = inviterLabel
    ? `${inviterLabel} invited you to join ${shopLabel} as a ${roleLabel} on Otopair.`
    : `You've been invited to join ${shopLabel} as a ${roleLabel} on Otopair.`;

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>You're invited to Otopair</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f3f4f6;">
  <!-- Preheader (hidden preview text) -->
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">You've been invited to join ${esc(shopName ?? "a shop")} on Otopair.</div>
  <table role="presentation" width="100%" style="border-collapse: collapse; background-color: #f3f4f6;">
    <tr>
      <td align="center" style="padding: 32px 16px;">
        <table role="presentation" width="100%" style="max-width: 520px; border-collapse: separate; background-color: #ffffff; border: 1px solid #eceef1; border-radius: 16px; overflow: hidden; box-shadow: 0 1px 2px rgba(17,24,39,0.04), 0 8px 24px rgba(17,24,39,0.06);">
          <!-- Brand header -->
          <tr>
            <td align="center" style="padding: 40px 40px 28px; background-color: #ffffff; border-bottom: 1px solid #eef0f3;">
              <img src="${logoUrl}" alt="Otopair" width="60" height="60" style="display:block;margin:0 auto 12px;border:0;" />
              <p style="margin:0 0 8px;color:#9ca3af;font-size:12px;font-weight:600;letter-spacing:2px;text-transform:uppercase;">Otopair</p>
              <h1 style="margin: 0; color: #111827; font-size: 22px; font-weight: 700; letter-spacing: -0.4px;">You're invited</h1>
            </td>
          </tr>

          <!-- Content -->
          <tr>
            <td style="padding: 36px 40px 8px;">
              <p style="margin: 0 0 18px; color: #111827; font-size: 16px; line-height: 1.6;">
                Hi ${greetingName},
              </p>

              <p style="margin: 0 0 18px; color: #374151; font-size: 16px; line-height: 1.65;">
                ${introLine}
              </p>

              <p style="margin: 0 0 8px; color: #374151; font-size: 16px; line-height: 1.65;">
                Otopair keeps your schedule, jobs, and payouts in one place. Set up your account below — it only takes a minute.
              </p>

              <!-- CTA Button -->
              <table role="presentation" width="100%" style="border-collapse: collapse; margin: 28px 0 8px;">
                <tr>
                  <td align="center">
                    <a href="${inviteUrl}" style="display: inline-block; padding: 15px 42px; background-color: #7cc7fb; color: #0f2a52; text-decoration: none; border-radius: 10px; font-weight: 700; font-size: 16px;">
                      Accept invitation
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin: 20px 0 4px; color: #9ca3af; font-size: 13px; line-height: 1.6; text-align: center;">
                Button not working? Paste this link into your browser:
              </p>
              <p style="margin: 0 0 8px; text-align: center;">
                <a href="${inviteUrl}" style="color: #0d72ff; font-size: 13px; word-break: break-all;">${inviteUrl}</a>
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 24px 40px 32px; border-top: 1px solid #f3f4f6;">
              <p style="margin: 0 0 4px; color: #6b7280; font-size: 13px; line-height: 1.5; text-align: center;">
                If you weren't expecting this invitation, you can safely ignore this email.
              </p>
              <p style="margin: 8px 0 0; color: #9ca3af; font-size: 12px; line-height: 1.6; text-align: center;">Otopair · The future of car repair coordination</p>
              <p style="margin: 4px 0 0; color: #9ca3af; font-size: 12px; line-height: 1.6; text-align: center;">© Otopair ${year}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `;
}
