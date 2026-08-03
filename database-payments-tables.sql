-- The Swap Yard — Payments & Verification Tables
-- Run this AFTER database-MASTER-v6.sql
-- Adds tables that create-checkout.js, stripe-webhook.js, escrow.js,
-- aml-compliance.js, tax-compliance.js, verify-user.js, and
-- barter-report.js read/write to.
-- ═══════════════════════════════════════════════════════════

-- ── ORDERS ───────────────────────────────────────────────────
-- Created by stripe-webhook.js when a Stripe checkout completes.
-- Works for ANY listing type with a price — including trade/barter
-- listings that have a cash component.
CREATE TABLE IF NOT EXISTS orders (
  id                     uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at             timestamptz DEFAULT now(),
  listing_id             uuid REFERENCES listings(id),
  buyer_id               uuid REFERENCES auth.users(id),
  buyer_email            text,
  vendor_id              uuid REFERENCES auth.users(id),
  vendor_stripe_account  text,
  vendor_plan            text DEFAULT 'free',
  stripe_session_id      text UNIQUE,
  stripe_payment_intent  text,
  amount_total           numeric NOT NULL,
  platform_fee           numeric NOT NULL,
  vendor_earnings        numeric NOT NULL,
  status                 text DEFAULT 'pending',   -- pending, paid, refunded, disputed
  shipping_status        text DEFAULT 'unshipped'  -- unshipped, shipped, delivered (vendor-managed, no platform shipping)
);

-- ── VENDOR STATS ─────────────────────────────────────────────
-- Rolling totals per vendor, updated by stripe-webhook.js
CREATE TABLE IF NOT EXISTS vendor_stats (
  user_id            uuid PRIMARY KEY REFERENCES auth.users(id),
  stripe_account_id  text,
  total_orders       int DEFAULT 0,
  total_revenue      numeric DEFAULT 0,
  last_sale_at       timestamptz,
  updated_at         timestamptz DEFAULT now()
);

-- ── ESCROWS ──────────────────────────────────────────────────
-- Optional buyer-protection holds (escrow.js)
CREATE TABLE IF NOT EXISTS escrows (
  id                     uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at             timestamptz DEFAULT now(),
  listing_id             uuid REFERENCES listings(id),
  buyer_id               uuid REFERENCES auth.users(id),
  stripe_payment_intent  text,
  amount_usd             numeric NOT NULL,
  platform_fee           numeric DEFAULT 0,
  escrow_fee             numeric DEFAULT 0,         -- 1% buyer-protection fee
  status                 text DEFAULT 'held',       -- held, released, disputed, refunded
  auto_release_at        timestamptz,               -- default hold period (7 days)
  released_at            timestamptz
);

-- ── AML CHECKS ───────────────────────────────────────────────
-- AML/BSA monitoring log (aml-compliance.js)
CREATE TABLE IF NOT EXISTS aml_checks (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  checked_at  timestamptz DEFAULT now(),
  user_id     uuid REFERENCES auth.users(id),
  listing_id  uuid REFERENCES listings(id),
  check_type  text,             -- e.g. 'velocity', 'structuring', 'high_risk_category'
  passed      bool DEFAULT true,
  flags       jsonb DEFAULT '[]'::jsonb
);

-- ── TAX ESTIMATES ────────────────────────────────────────────
-- Informational only — tax-compliance.js. Not submitted to IRS.
CREATE TABLE IF NOT EXISTS tax_estimates (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at      timestamptz DEFAULT now(),
  user_id         uuid REFERENCES auth.users(id),
  listing_id      uuid REFERENCES listings(id),
  fmv_received    numeric,
  fmv_given       numeric,
  estimated_tax   numeric
);

-- ── VERIFICATION CODES ───────────────────────────────────────
-- Twilio SMS verification codes (verify-user.js)
CREATE TABLE IF NOT EXISTS verification_codes (
  user_id     uuid PRIMARY KEY REFERENCES auth.users(id),
  code        text NOT NULL,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz DEFAULT now()
);

-- ── BARTER TRANSACTIONS ──────────────────────────────────────
-- Vendor's own record-keeping for trades/barters (barter-report.js)
CREATE TABLE IF NOT EXISTS barter_transactions (
  id               uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at       timestamptz DEFAULT now(),
  user_id          uuid REFERENCES auth.users(id),
  listing_id       uuid REFERENCES listings(id),
  item_received    text,
  item_given       text,
  fmv_received     numeric,
  fmv_given        numeric,
  notes            text
);

-- ── BLOCKED REASON COLUMN ────────────────────────────────────
-- aml-compliance.js sets this when blocking an account
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS blocked_reason text;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS phone_verified bool DEFAULT false;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS id_verified bool DEFAULT false;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS stripe_account_id text;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS stripe_verify_session text;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS plan text DEFAULT 'free';

-- ── RLS ──────────────────────────────────────────────────────
ALTER TABLE orders               ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_stats         ENABLE ROW LEVEL SECURITY;
ALTER TABLE escrows              ENABLE ROW LEVEL SECURITY;
ALTER TABLE aml_checks           ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_estimates        ENABLE ROW LEVEL SECURITY;
ALTER TABLE verification_codes   ENABLE ROW LEVEL SECURITY;
ALTER TABLE barter_transactions  ENABLE ROW LEVEL SECURITY;

CREATE POLICY "orders_own_buyer"   ON orders  FOR SELECT USING (auth.uid() = buyer_id);
CREATE POLICY "orders_own_vendor"  ON orders  FOR SELECT USING (auth.uid() = vendor_id);
CREATE POLICY "vendor_stats_own"   ON vendor_stats FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "escrows_own_buyer"  ON escrows FOR SELECT USING (auth.uid() = buyer_id);
CREATE POLICY "tax_estimates_own"  ON tax_estimates FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "verification_own"   ON verification_codes FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "barter_tx_own"      ON barter_transactions FOR ALL USING (auth.uid() = user_id);
-- aml_checks: no public policy — service role only (admin/back-office)

-- ── INDEXES ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_orders_listing  ON orders(listing_id);
CREATE INDEX IF NOT EXISTS idx_orders_buyer    ON orders(buyer_id);
CREATE INDEX IF NOT EXISTS idx_orders_vendor   ON orders(vendor_id);
CREATE INDEX IF NOT EXISTS idx_escrows_buyer   ON escrows(buyer_id);
CREATE INDEX IF NOT EXISTS idx_aml_user        ON aml_checks(user_id);
