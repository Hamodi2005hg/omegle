-- ==============================================================================
-- OMEGOOO DATABASE SCHEMA (PostgreSQL / Supabase)
-- ==============================================================================

-- 1. جدول مخالفات السلوك والمحتوى الإباحي التدريجي (NSFW & Behavior Violations)
-- المخالفة الأولى: 24 ساعة (24 Hours)
-- المخالفة الثانية وتكرار السلوك: 3 أيام (72 Hours / 3 Days)
-- المخالفات اللاحقة: 7 أيام / حظر دائم
CREATE TABLE IF NOT EXISTS nsfw_violations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ip TEXT NOT NULL,
    fp TEXT,
    offense_count INTEGER DEFAULT 1,
    reason TEXT DEFAULT 'NSFW / Inappropriate Content Violation',
    ban_duration_hours INTEGER DEFAULT 24,
    banned_until TIMESTAMPTZ NOT NULL,
    status TEXT DEFAULT 'ACTIVE', -- 'ACTIVE', 'EXPIRED', 'PARDONED'
    details JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nsfw_violations_ip ON nsfw_violations(ip);
CREATE INDEX IF NOT EXISTS idx_nsfw_violations_fp ON nsfw_violations(fp);
CREATE INDEX IF NOT EXISTS idx_nsfw_violations_banned_until ON nsfw_violations(banned_until);

-- 2. جدول الحظر النشط (Active Bans)
CREATE TABLE IF NOT EXISTS active_bans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type TEXT NOT NULL, -- 'ip' or 'fp'
    value TEXT NOT NULL,
    expiry BIGINT NOT NULL, -- Unix timestamp in ms
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_active_bans_type_value ON active_bans(type, value);
CREATE INDEX IF NOT EXISTS idx_active_bans_expiry ON active_bans(expiry);

-- 3. جدول سجل الحظر التاريخي (Bans History)
CREATE TABLE IF NOT EXISTS bans_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type TEXT NOT NULL,
    value TEXT NOT NULL,
    reason TEXT,
    expires_at TIMESTAMPTZ,
    unbanned_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. جدول الزوار (Visitors Analytics)
CREATE TABLE IF NOT EXISTS visitors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ip TEXT NOT NULL,
    fp TEXT,
    country TEXT,
    user_agent TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_visitors_created_at ON visitors(created_at);
CREATE INDEX IF NOT EXISTS idx_visitors_country ON visitors(country);

-- 5. جدول الإحصائيات اليومية (Daily Stats)
CREATE TABLE IF NOT EXISTS daily_stats (
    date DATE PRIMARY KEY,
    visitor_count INTEGER DEFAULT 0,
    unique_visitors INTEGER DEFAULT 0
);

-- 6. جدول البلاغات النشطة (Active Reports)
CREATE TABLE IF NOT EXISTS active_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "targetId" TEXT NOT NULL,
    "reporterId" TEXT NOT NULL,
    screenshot TEXT,
    ts BIGINT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 7. جدول سجل البلاغات التاريخية (Reports History)
CREATE TABLE IF NOT EXISTS reports_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    target TEXT NOT NULL,
    reporter TEXT NOT NULL,
    screenshot TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 8. جدول البلدان المحظورة (Banned Countries)
CREATE TABLE IF NOT EXISTS banned_countries (
    code TEXT PRIMARY KEY,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 9. جدول محاولات تسجيل الدخول للوحة الإدارة (Admin Login Attempts)
CREATE TABLE IF NOT EXISTS login_attempts (
    id TEXT PRIMARY KEY,
    ip TEXT NOT NULL,
    success BOOLEAN DEFAULT FALSE,
    status TEXT DEFAULT 'FAILED',
    user_agent TEXT,
    timestamp TIMESTAMPTZ DEFAULT NOW()
);

-- 10. جدول رسائل اتصل بنا (Contact Messages)
CREATE TABLE IF NOT EXISTS contact_messages (
    id TEXT PRIMARY KEY,
    name TEXT,
    email TEXT,
    subject TEXT,
    message TEXT,
    read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 11. جدول المقالات والمدونة (Blog Posts)
CREATE TABLE IF NOT EXISTS blog_posts (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    slug TEXT UNIQUE,
    category TEXT,
    meta_description TEXT,
    keywords TEXT,
    thumbnail_url TEXT,
    read_time TEXT,
    content TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
