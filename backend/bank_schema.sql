-- ============================================================
-- KrishiSethu — Bank Onboarding Schema
-- Run this in Supabase SQL Editor
-- ============================================================

-- 1. Verified bank accounts (final storage)
CREATE TABLE IF NOT EXISTS public.bank_accounts (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_holder_name         TEXT NOT NULL,
  account_number              TEXT,                        -- NULL if UPI only
  ifsc_code                   TEXT,                        -- NULL if UPI only
  upi_id                      TEXT,                        -- NULL if account number used
  account_type                TEXT DEFAULT 'savings',      -- savings | current
  bank_id                     TEXT,                        -- e.g. 'SBI', 'HDFC'
  card_last6                  TEXT,                        -- last 6 digits of debit card
  card_expiry_month           TEXT,
  card_expiry_year            TEXT,
  razorpay_contact_id         TEXT,                        -- Razorpay contact ID
  razorpay_fund_account_id    TEXT,                        -- Razorpay fund account ID
  razorpay_linked_account_id  TEXT,                        -- Razorpay Route linked account (farmers only)
  is_verified                 BOOLEAN DEFAULT false,
  created_at                  TIMESTAMPTZ DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id)                                          -- One bank account per user
);

-- 2. Temporary verification sessions (penny drop)
CREATE TABLE IF NOT EXISTS public.bank_account_verifications (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  reference_id               TEXT NOT NULL UNIQUE,
  razorpay_contact_id        TEXT,
  razorpay_fund_account_id   TEXT,
  razorpay_payout_id         TEXT,
  amount_hash                TEXT NOT NULL,               -- HMAC of actual paise sent (never stored plaintext)
  account_holder_name        TEXT,
  account_number             TEXT,
  ifsc_code                  TEXT,
  upi_id                     TEXT,
  account_type               TEXT,
  bank_id                    TEXT,
  attempts                   INT DEFAULT 0,
  status                     TEXT DEFAULT 'pending',      -- pending | amount_verified | completed | expired
  expires_at                 TIMESTAMPTZ NOT NULL,
  created_at                 TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Add payout tracking columns to orders table
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS route_transfer_linked  BOOLEAN DEFAULT false;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS farmer_fund_account_id TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS payout_reference        TEXT;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS farmer_confirmed_at     TIMESTAMPTZ;

-- ── Row Level Security ────────────────────────────────────────

ALTER TABLE public.bank_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bank_account_verifications ENABLE ROW LEVEL SECURITY;

-- bank_accounts: users can read/write only their own
DROP POLICY IF EXISTS "bank_accounts_own" ON public.bank_accounts;
CREATE POLICY "bank_accounts_own" ON public.bank_accounts
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Service role can read any bank account (for payout logic)
DROP POLICY IF EXISTS "bank_accounts_service" ON public.bank_accounts;
CREATE POLICY "bank_accounts_service" ON public.bank_accounts
  FOR SELECT TO service_role USING (true);

-- Verifications: users can read only their own
DROP POLICY IF EXISTS "verifications_own" ON public.bank_account_verifications;
CREATE POLICY "verifications_own" ON public.bank_account_verifications
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ── Auto-expire old verifications (cleanup) ───────────────────
-- Run this as a Supabase scheduled function or cron job
-- UPDATE public.bank_account_verifications
--   SET status = 'expired'
--   WHERE expires_at < NOW() AND status = 'pending';

-- ── Indexes ───────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_bank_accounts_user ON public.bank_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_verifications_ref  ON public.bank_account_verifications(reference_id);
CREATE INDEX IF NOT EXISTS idx_verifications_user ON public.bank_account_verifications(user_id);
