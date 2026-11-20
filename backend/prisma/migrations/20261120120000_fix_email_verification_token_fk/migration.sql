-- The EmailVerificationToken FK was written by hand without ON UPDATE CASCADE,
-- which is Prisma's default referential action for a relation. `migrate diff`
-- therefore reported the migration history and schema.prisma as drifted on
-- every backend CI run. Recreate the constraint with the actions Prisma expects.
ALTER TABLE "EmailVerificationToken" DROP CONSTRAINT "EmailVerificationToken_userId_fkey";
ALTER TABLE "EmailVerificationToken" ADD CONSTRAINT "EmailVerificationToken_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
