-- ═══════════════════════════════════════════════════════════
-- The Swap Yard — Community Feature Tables
-- Run in Supabase → SQL Editor → New query → Run
-- ═══════════════════════════════════════════════════════════

-- ── COMMUNITIES ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS communities (
  id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at   timestamptz DEFAULT now(),
  name         text NOT NULL,
  slug         text UNIQUE NOT NULL,
  description  text,
  category     text,
  cover_url    text,
  icon         text DEFAULT '🏘️',
  creator_id   uuid REFERENCES auth.users(id),
  member_count int DEFAULT 0,
  post_count   int DEFAULT 0,
  is_active    bool DEFAULT true,
  is_private   bool DEFAULT false
);

-- ── COMMUNITY MEMBERS ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS community_members (
  id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  community_id uuid REFERENCES communities(id) ON DELETE CASCADE,
  user_id      uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  role         text DEFAULT 'member',  -- member, moderator, admin
  joined_at    timestamptz DEFAULT now(),
  UNIQUE(community_id, user_id)
);

-- ── COMMUNITY POSTS (Feed) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS community_posts (
  id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at   timestamptz DEFAULT now(),
  community_id uuid REFERENCES communities(id) ON DELETE CASCADE,
  user_id      uuid REFERENCES auth.users(id),
  body         text NOT NULL,
  image_url    text,
  listing_id   uuid REFERENCES listings(id),
  like_count   int DEFAULT 0,
  reply_count  int DEFAULT 0,
  is_pinned    bool DEFAULT false,
  is_visible   bool DEFAULT true
);

-- ── COMMUNITY POST LIKES ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS community_post_likes (
  post_id  uuid REFERENCES community_posts(id) ON DELETE CASCADE,
  user_id  uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  liked_at timestamptz DEFAULT now(),
  PRIMARY KEY (post_id, user_id)
);

-- ── COMMUNITY EVENTS ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS community_events (
  id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at   timestamptz DEFAULT now(),
  community_id uuid REFERENCES communities(id) ON DELETE CASCADE,
  creator_id   uuid REFERENCES auth.users(id),
  title        text NOT NULL,
  description  text,
  event_date   timestamptz,
  location     text,
  is_virtual   bool DEFAULT false,
  rsvp_count   int DEFAULT 0
);

-- ── COMMUNITY CHAT ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS community_chat (
  id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at   timestamptz DEFAULT now(),
  community_id uuid REFERENCES communities(id) ON DELETE CASCADE,
  user_id      uuid REFERENCES auth.users(id),
  body         text NOT NULL,
  is_visible   bool DEFAULT true
);

-- ── ADD community_id TO LISTINGS ─────────────────────────────
ALTER TABLE listings ADD COLUMN IF NOT EXISTS community_id uuid REFERENCES communities(id);
ALTER TABLE listings ADD COLUMN IF NOT EXISTS community_name text;

-- ── ENABLE RLS ────────────────────────────────────────────────
ALTER TABLE communities        ENABLE ROW LEVEL SECURITY;
ALTER TABLE community_members  ENABLE ROW LEVEL SECURITY;
ALTER TABLE community_posts    ENABLE ROW LEVEL SECURITY;
ALTER TABLE community_post_likes ENABLE ROW LEVEL SECURITY;
ALTER TABLE community_events   ENABLE ROW LEVEL SECURITY;
ALTER TABLE community_chat     ENABLE ROW LEVEL SECURITY;

-- ── DROP OLD POLICIES ─────────────────────────────────────────
DROP POLICY IF EXISTS "communities_read"        ON communities;
DROP POLICY IF EXISTS "communities_insert"      ON communities;
DROP POLICY IF EXISTS "communities_own"         ON communities;
DROP POLICY IF EXISTS "cm_read"                 ON community_members;
DROP POLICY IF EXISTS "cm_join"                 ON community_members;
DROP POLICY IF EXISTS "cm_leave"                ON community_members;
DROP POLICY IF EXISTS "cp_read"                 ON community_posts;
DROP POLICY IF EXISTS "cp_insert"               ON community_posts;
DROP POLICY IF EXISTS "cp_own"                  ON community_posts;
DROP POLICY IF EXISTS "cpl_read"                ON community_post_likes;
DROP POLICY IF EXISTS "cpl_insert"              ON community_post_likes;
DROP POLICY IF EXISTS "ce_read"                 ON community_events;
DROP POLICY IF EXISTS "ce_insert"               ON community_events;
DROP POLICY IF EXISTS "cc_read"                 ON community_chat;
DROP POLICY IF EXISTS "cc_insert"               ON community_chat;

-- ── CREATE POLICIES ───────────────────────────────────────────
-- Communities
CREATE POLICY "communities_read"   ON communities FOR SELECT USING (is_active = true);
CREATE POLICY "communities_insert" ON communities FOR INSERT WITH CHECK (auth.uid() = creator_id);
CREATE POLICY "communities_own"    ON communities FOR UPDATE USING (auth.uid() = creator_id);

-- Members
CREATE POLICY "cm_read"   ON community_members FOR SELECT USING (true);
CREATE POLICY "cm_join"   ON community_members FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "cm_leave"  ON community_members FOR DELETE USING (auth.uid() = user_id);

-- Posts
CREATE POLICY "cp_read"   ON community_posts FOR SELECT USING (is_visible = true);
CREATE POLICY "cp_insert" ON community_posts FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "cp_own"    ON community_posts FOR UPDATE USING (auth.uid() = user_id);

-- Likes
CREATE POLICY "cpl_read"   ON community_post_likes FOR SELECT USING (true);
CREATE POLICY "cpl_insert" ON community_post_likes FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Events
CREATE POLICY "ce_read"   ON community_events FOR SELECT USING (true);
CREATE POLICY "ce_insert" ON community_events FOR INSERT WITH CHECK (auth.uid() = creator_id);

-- Chat
CREATE POLICY "cc_read"   ON community_chat FOR SELECT USING (is_visible = true);
CREATE POLICY "cc_insert" ON community_chat FOR INSERT WITH CHECK (auth.uid() = user_id);

-- ── INDEXES ───────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_cm_community  ON community_members(community_id);
CREATE INDEX IF NOT EXISTS idx_cm_user       ON community_members(user_id);
CREATE INDEX IF NOT EXISTS idx_cp_community  ON community_posts(community_id);
CREATE INDEX IF NOT EXISTS idx_ce_community  ON community_events(community_id);
CREATE INDEX IF NOT EXISTS idx_cc_community  ON community_chat(community_id);
CREATE INDEX IF NOT EXISTS idx_listings_comm ON listings(community_id);

-- ── TRIGGER: auto-update member_count ────────────────────────
CREATE OR REPLACE FUNCTION update_community_member_count()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE communities SET member_count = member_count + 1 WHERE id = NEW.community_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE communities SET member_count = GREATEST(member_count - 1, 0) WHERE id = OLD.community_id;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_member_change ON community_members;
CREATE TRIGGER on_member_change
  AFTER INSERT OR DELETE ON community_members
  FOR EACH ROW EXECUTE FUNCTION update_community_member_count();

-- ── TRIGGER: auto-update post_count ──────────────────────────
CREATE OR REPLACE FUNCTION update_community_post_count()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE communities SET post_count = post_count + 1 WHERE id = NEW.community_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE communities SET post_count = GREATEST(post_count - 1, 0) WHERE id = OLD.community_id;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_post_change ON community_posts;
CREATE TRIGGER on_post_change
  AFTER INSERT OR DELETE ON community_posts
  FOR EACH ROW EXECUTE FUNCTION update_community_post_count();

-- ── SEED: starter communities for RTP ────────────────────────
INSERT INTO communities (name, slug, description, category, icon, is_active)
VALUES
  ('RTP Gardeners', 'rtp-gardeners', 'Trade seeds, tools, plants and garden gear across the Triangle.', 'gardening', '🌱', true),
  ('Triangle Car Enthusiasts', 'triangle-cars', 'Parts, tools, and car culture for RTP gearheads.', 'automotive', '🚗', true),
  ('Vintage Vinyl Collectors', 'vinyl-collectors', 'Buy, sell, trade records and audio equipment.', 'music', '🎵', true),
  ('Tech & Electronics RTP', 'rtp-tech', 'Phones, laptops, cameras, cables and gadgets.', 'electronics', '💻', true),
  ('Home & Furniture Triangle', 'rtp-home', 'Furniture, decor, kitchen, and home goods.', 'home', '🏠', true),
  ('RTP Outdoor & Sports', 'rtp-outdoors', 'Bikes, camping gear, sports equipment and more.', 'outdoors', '🏕️', true)
ON CONFLICT (slug) DO NOTHING;
