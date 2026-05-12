-- Adds a separate media source library so recipe feeds can auto-pick video content
-- without requiring a video_url on every recipe record.

CREATE TABLE IF NOT EXISTS recipe_media_sources (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title VARCHAR(200) NOT NULL,
    platform VARCHAR(20) NOT NULL DEFAULT 'youtube' CHECK (platform IN ('tiktok', 'youtube', 'internal')),
    media_url TEXT,
    category VARCHAR(50),
    cuisine VARCHAR(50),
    tags JSONB DEFAULT '[]',
    recipe_id UUID REFERENCES recipes(id) ON DELETE SET NULL,
    is_active BOOLEAN DEFAULT true,
    sort_order INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_recipe_media_sources_active_sort
    ON recipe_media_sources(is_active, sort_order, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_recipe_media_sources_category
    ON recipe_media_sources(category);

CREATE INDEX IF NOT EXISTS idx_recipe_media_sources_cuisine
    ON recipe_media_sources(cuisine);

CREATE INDEX IF NOT EXISTS idx_recipe_media_sources_tags
    ON recipe_media_sources USING GIN(tags);
