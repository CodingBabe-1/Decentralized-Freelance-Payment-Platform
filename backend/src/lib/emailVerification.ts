/**
 * emailVerification.ts
 *
 * Email ownership verification to prevent unauthorized notification activation (issue #233).
 *
 * When a user sets or changes their email address, they must verify ownership before
 * enabling any notification preferences. The flow is:
 * 1. User sets email in PUT /api/users/me
 * 2. Server generates a verification token and sends an email
 * 3. User clicks the link and calls GET /api/users/me/verify-email?token=...
 * 4. Server marks email as verified, user can now enable notifications
 */

import { randomBytes } from "node:crypto";
import { config } from "../config";
import { getEmailProvider } from "./notifications";

/** Email verification token lifetime. */
export const EMAIL_VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Generate a random verification token.
 */
export function generateVerificationToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Send a verification email to the given address.
 * The email contains a link to verify ownership.
 */
export async function sendVerificationEmail(
  email: string,
  verificationToken: string,
  stellarAddress: string,
): Promise<void> {
  const provider = getEmailProvider();
  const verificationUrl = `${config.FRONTEND_URL}/verify-email?token=${encodeURIComponent(verificationToken)}`;

  const text = [
    `Hello,`,
    ``,
    `Please verify your email address by clicking the link below:`,
    ``,
    `${verificationUrl}`,
    ``,
    `This link will expire in 24 hours.`,
    ``,
    `If you did not request this verification, you can safely ignore this email.`,
    ``,
    `Best regards,`,
    `The Stellar Freelance Platform`,
  ].join("\n");

  await provider.sendEmail({
    to: email,
    subject: "Verify Your Email Address",
    text,
  });
}

/**
 * Check if an email is verified for a user.
 * Returns true if the email is verified or if email verification is disabled.
 */
export function isEmailVerified(emailVerifiedAt: Date | null): boolean {
  // If emailVerifiedAt is set, email is verified
  return emailVerifiedAt !== null;
}
