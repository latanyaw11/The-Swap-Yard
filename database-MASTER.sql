-- The Swap Yard — Lean Database Schema
-- Run this entire file in Supabase → SQL Editor → New query → Run

-- ── PROFILES ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS profiles (
  id               uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at       timestamptz DEFAULT now(),
  display_name     text,
  email            text,
  phone            text,
  city             text DEFAULT 'Durham',
  state            text DEFAULT 'NC',
  zip              text DEFAULT '27709',
  bio              text,
  avatar_url       text,
  email_verified   bool DEFAULT false,
  phone_verified   bool DEFAULT false,
  id_verified      bool DEFAULT false,
  certified_categories text[],
  referral_code    text UNIQUE,
  referral_credits int DEFAULT 0,
  referral_count   int DEFAULT 0,
  listing_credits  int DEFAULT 0,
  referred_by      uuid REFERENCES auth.users(id),
  is_active        bool DEFAULT true,
  -- Social links stored as JSON
  social_links     jsonb DEFAULT '{}'::jsonb
);

-- ── LISTINGS ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS listings (
  id               uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at       timestamptz DEFAULT now(),
  updated_at       timestamptz DEFAULT now(),
  user_id          uuid REFERENCES auth.users(id),
  title            text NOT NULL,
  description      text,
  type             text DEFAULT 'goods',
  category         text,
  price_usd        numeric,
  accepts          text[],
  barter_for       text,
  seller_name      text,
  seller_contact   text,
  emoji            text DEFAULT '📦',
  images           text[] DEFAULT '{}',
  certified        bool DEFAULT false,
  is_boosted       bool DEFAULT false,
  boost_tier       text,
  boost_expires_at timestamptz,
  fulfillment      text DEFAULT 'local',
  city             text DEFAULT 'Durham',
  state            text DEFAULT 'NC',
  zip              text DEFAULT '27709',
  avg_rating       numeric DEFAULT 0,
  review_count     int DEFAULT 0,
  is_active        bool DEFAULT true,
  event_type       text,
  event_date       date,
  event_start      time,
  event_end        time,
  event_address    text
);

ALTER TABLE listings ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english',
      coalesce(title,'') || ' ' || coalesce(description,'') || ' ' ||
      coalesce(category,'') || ' ' || coalesce(city,'') || ' ' ||
      coalesce(barter_for,''))
  ) STORED;

-- ── REVIEWS ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reviews (
  id               uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at       timestamptz DEFAULT now(),
  listing_id       uuid REFERENCES listings(id),
  reviewer_id      uuid REFERENCES auth.users(id),
  rating           int CHECK (rating BETWEEN 1 AND 5),
  text             text,
  is_visible       bool DEFAULT true,
  moderation_flags jsonb,
  moderated_at     timestamptz
);

-- ── MESSAGES ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at    timestamptz DEFAULT now(),
  thread_id     uuid,
  sender_id     uuid REFERENCES auth.users(id),
  receiver_id   uuid REFERENCES auth.users(id),
  listing_id    uuid REFERENCES listings(id),
  body          text NOT NULL,
  is_read       bool DEFAULT false,
  msg_type      text DEFAULT 'message'
);

-- ── WISHLISTS ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wishlists (
  id         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id    uuid REFERENCES auth.users(id),
  listing_id uuid REFERENCES listings(id),
  created_at timestamptz DEFAULT now(),
  UNIQUE(user_id, listing_id)
);

-- ── SAVED SEARCHES ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS saved_searches (
  id         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id    uuid REFERENCES auth.users(id),
  name       text,
  query      text,
  filters    jsonb,
  is_active  bool DEFAULT true,
  last_alert timestamptz,
  created_at timestamptz DEFAULT now()
);

-- ── BOOSTS ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS boosts (
  id         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  listing_id uuid REFERENCES listings(id),
  tier       text,
  expires_at timestamptz,
  created_at timestamptz DEFAULT now()
);

-- ── REFERRALS ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS referrals (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  referrer_id uuid REFERENCES auth.users(id),
  referred_id uuid REFERENCES auth.users(id),
  status      text DEFAULT 'pending',
  code        text,
  created_at  timestamptz DEFAULT now()
);

-- ── PUSH SUBSCRIPTIONS ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id      uuid REFERENCES auth.users(id) UNIQUE,
  subscription jsonb,
  created_at   timestamptz DEFAULT now()
);

-- ── ANALYTICS ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS analytics_daily (
  date          date PRIMARY KEY,
  new_users     int DEFAULT 0,
  new_listings  int DEFAULT 0,
  messages_sent int DEFAULT 0,
  affiliate_clicks int DEFAULT 0,
  top_categories jsonb,
  created_at    timestamptz DEFAULT now()
);

-- ── SPONSORS ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sponsors (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_name  text NOT NULL,
  logo_url      text,
  website_url   text,
  tagline       text,
  slot          text,
  is_active     bool DEFAULT true,
  display_order int  DEFAULT 0,
  contract_start date,
  contract_end   date,
  monthly_fee    numeric,
  contact_email  text,
  created_at    timestamptz DEFAULT now()
);

-- ── AFFILIATE CLICKS ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS affiliate_clicks (
  id         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  listing_id uuid REFERENCES listings(id),
  user_id    uuid REFERENCES auth.users(id),
  program    text,
  destination text,
  category   text,
  clicked_at timestamptz DEFAULT now()
);

-- ── AFFILIATE IMPRESSIONS ────────────────────────────────────
CREATE TABLE IF NOT EXISTS affiliate_impressions (
  id         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  listing_id uuid REFERENCES listings(id),
  user_id    uuid REFERENCES auth.users(id),
  category   text,
  created_at timestamptz DEFAULT now()
);

-- ── FRAUD CHECKS ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fraud_checks (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  entity_type text,
  entity_id   uuid,
  user_id     uuid REFERENCES auth.users(id),
  flags       jsonb,
  action      text,
  cleared     bool DEFAULT false,
  checked_at  timestamptz DEFAULT now()
);

-- ── WAITLIST ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS waitlist (
  id         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  type       text NOT NULL,
  user_id    uuid REFERENCES auth.users(id),
  email      text NOT NULL,
  name       text,
  city       text,
  status     text DEFAULT 'waiting',
  position   int,
  joined_at  timestamptz DEFAULT now(),
  UNIQUE(type, email)
);

-- ── SUPPORT CONVERSATIONS ────────────────────────────────────
CREATE TABLE IF NOT EXISTS support_conversations (
  id         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id    uuid REFERENCES auth.users(id),
  question   text,
  answer     text,
  escalated  bool DEFAULT false,
  created_at timestamptz DEFAULT now()
);

-- ── RLS ──────────────────────────────────────────────────────
ALTER TABLE profiles            ENABLE ROW LEVEL SECURITY;
ALTER TABLE listings            ENABLE ROW LEVEL SECURITY;
ALTER TABLE reviews             ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages            ENABLE ROW LEVEL SECURITY;
ALTER TABLE wishlists           ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_searches      ENABLE ROW LEVEL SECURITY;
ALTER TABLE boosts              ENABLE ROW LEVEL SECURITY;
ALTER TABLE referrals           ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_subscriptions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE sponsors            ENABLE ROW LEVEL SECURITY;
ALTER TABLE affiliate_clicks    ENABLE ROW LEVEL SECURITY;
ALTER TABLE fraud_checks        ENABLE ROW LEVEL SECURITY;
ALTER TABLE waitlist            ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_conversations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "profiles_read"   ON profiles  FOR SELECT USING (true);
CREATE POLICY "profiles_own"    ON profiles  FOR ALL    USING (auth.uid() = id);
CREATE POLICY "listings_read"   ON listings  FOR SELECT USING (is_active = true);
CREATE POLICY "listings_own"    ON listings  FOR ALL    USING (auth.uid() = user_id);
CREATE POLICY "reviews_read"    ON reviews   FOR SELECT USING (is_visible = true);
CREATE POLICY "reviews_insert"  ON reviews   FOR INSERT WITH CHECK (auth.uid() = reviewer_id);
CREATE POLICY "messages_own"    ON messages  FOR SELECT USING (auth.uid() = sender_id OR auth.uid() = receiver_id);
CREATE POLICY "messages_insert" ON messages  FOR INSERT WITH CHECK (auth.uid() = sender_id);
CREATE POLICY "wishlists_own"   ON wishlists FOR ALL    USING (auth.uid() = user_id);
CREATE POLICY "searches_own"    ON saved_searches FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "sponsors_public" ON sponsors  FOR SELECT USING (is_active = true);
CREATE POLICY "aff_clicks_insert" ON affiliate_clicks FOR INSERT WITH CHECK (true);
CREATE POLICY "push_own"        ON push_subscriptions FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "waitlist_own"    ON waitlist  FOR ALL    USING (auth.uid() = user_id);
CREATE POLICY "waitlist_insert" ON waitlist  FOR INSERT WITH CHECK (true);
CREATE POLICY "support_own"     ON support_conversations FOR ALL USING (auth.uid() = user_id);

-- ── TRIGGERS ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO profiles (id, email, display_name)
  VALUES (NEW.id, NEW.email, split_part(NEW.email, '@', 1))
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

CREATE OR REPLACE FUNCTION update_listing_rating()
RETURNS trigger AS $$
BEGIN
  UPDATE listings SET
    avg_rating   = (SELECT ROUND(AVG(rating)::numeric,2) FROM reviews WHERE listing_id=NEW.listing_id AND is_visible=true),
    review_count = (SELECT COUNT(*) FROM reviews WHERE listing_id=NEW.listing_id AND is_visible=true)
  WHERE id = NEW.listing_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_review_created ON reviews;
CREATE TRIGGER on_review_created
  AFTER INSERT ON reviews
  FOR EACH ROW EXECUTE FUNCTION update_listing_rating();

-- ── INDEXES ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_listings_user    ON listings(user_id);
CREATE INDEX IF NOT EXISTS idx_listings_active  ON listings(is_active);
CREATE INDEX IF NOT EXISTS idx_listings_fts     ON listings USING GIN(search_vector);
CREATE INDEX IF NOT EXISTS idx_listings_boosted ON listings(is_boosted) WHERE is_boosted=true;
CREATE INDEX IF NOT EXISTS idx_messages_thread  ON messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_wishlists_user   ON wishlists(user_id);
CREATE INDEX IF NOT EXISTS idx_reviews_listing  ON reviews(listing_id);

-- ── SOCIAL LINKS COLUMN (if profiles already exists) ─────────
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS social_links jsonb DEFAULT '{}'::jsonb;
-- The Swap Yard — Payment Methods & QR Codes Schema
-- Run in Supabase → SQL Editor after database.sql
-- ═══════════════════════════════════════════════════

-- Add payment method columns to profiles
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS
  accepted_payments  text[]  DEFAULT ARRAY['card','cash'];

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS
  payment_qr_codes   jsonb   DEFAULT '{}'::jsonb;

-- accepted_payments: array of strings
--   Valid values: 'card', 'cash', 'venmo', 'zelle', 'paypal', 'cashapp'
--   Example: ARRAY['card','cash','venmo','zelle']

-- payment_qr_codes: JSON object with URLs
--   Example: {"venmo":"https://...","zelle":"https://...","cashapp":"https://..."}
--   URLs point to images stored in Supabase Storage listing-images bucket

-- Add social links if not already present
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS
  social_links jsonb DEFAULT '{}'::jsonb;

-- ── SUPABASE STORAGE — allow QR code uploads ─────────────────
-- Run this in SQL Editor to add policy for payment QR uploads
-- (listing-images bucket must already exist and be public)

-- Policy: allow authenticated users to upload to payment-qr folder
-- This extends your existing listing-images policy
DO $$
BEGIN
  INSERT INTO storage.policies (name, bucket_id, operation, definition)
  VALUES (
    'Allow QR uploads',
    'listing-images',
    'INSERT',
    '(auth.uid()::text = (storage.foldername(name))[1])'
  )
  ON CONFLICT DO NOTHING;
EXCEPTION WHEN OTHERS THEN
  NULL; -- policy already exists
END $$;

-- ── INDEX for fast lookup ─────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_profiles_payments
  ON profiles USING GIN (accepted_payments);

-- ── VIEW: listings with vendor payment info ──────────────────
-- Joins listing with vendor's accepted payments and QR codes
-- Used when building listing detail modals
CREATE OR REPLACE VIEW listings_with_payments AS
SELECT
  l.*,
  p.accepted_payments  AS vendor_accepts,
  p.payment_qr_codes   AS vendor_qr_codes,
  p.social_links       AS vendor_social_links,
  p.display_name       AS vendor_display_name
FROM listings l
LEFT JOIN profiles p ON p.id = l.user_id
WHERE l.is_active = true;

-- Grant public read on the view
GRANT SELECT ON listings_with_payments TO anon, authenticated;
