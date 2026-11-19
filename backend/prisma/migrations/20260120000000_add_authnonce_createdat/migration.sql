-- Add createdAt field to AuthNonce for signature expiration verification (issue #235)
ALTER TABLE "AuthNonce" ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
