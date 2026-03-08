import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_KEY);

/**
 * Send invite link email to an existing Clerk user
 */
export async function sendInviteEmail({
  email,
  inviteUrl,
}: {
  email: string;
  inviteUrl: string;
}) {
  try {
    const result = await resend.emails.send({
      from: 'Otopair <info@otopair.com>',
      to: email,
      subject: "You've been invited to join Otopair",
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
                You've been invited to join a shop on <strong>Otopair</strong>. Click the button below to accept your invitation and get started.
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

