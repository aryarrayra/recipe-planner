-- =====================================================
-- DATABASE SCHEMA FOR AI RECIPE PLANNER
-- =====================================================

-- 1. Tabel Users
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    avatar_url TEXT,
    bio TEXT,
    dietary_preferences JSONB DEFAULT '[]',
    allergies JSONB DEFAULT '[]',
    favorite_cuisines JSONB DEFAULT '[]',
    budget_per_meal DECIMAL(10,2) DEFAULT 15000,
    cooking_skill_level VARCHAR(20) DEFAULT 'beginner',
    total_recipes_cooked INT DEFAULT 0,
    total_recipes_shared INT DEFAULT 0,
    total_saved_recipes INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. Tabel Recipes
CREATE TABLE IF NOT EXISTS recipes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id VARCHAR(100),
    source VARCHAR(50) DEFAULT 'user',
    title VARCHAR(200) NOT NULL,
    description TEXT,
    image_url TEXT,
    video_url TEXT,
    cooking_time INT,
    servings INT DEFAULT 1,
    difficulty VARCHAR(20),
    ingredients JSONB NOT NULL,
    steps JSONB NOT NULL,
    calories INT,
    protein DECIMAL(10,2),
    carbs DECIMAL(10,2),
    fat DECIMAL(10,2),
    category VARCHAR(50),
    cuisine VARCHAR(50),
    tags JSONB DEFAULT '[]',
    estimated_price DECIMAL(10,2),
    price_rating VARCHAR(10),
    likes_count INT DEFAULT 0,
    saves_count INT DEFAULT 0,
    comments_count INT DEFAULT 0,
    views_count INT DEFAULT 0,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    is_approved BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 3. Tabel Recipe Media Sources
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

-- 4. Tabel User Favorites
CREATE TABLE IF NOT EXISTS user_favorites (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    recipe_id UUID REFERENCES recipes(id) ON DELETE CASCADE,
    collection_name VARCHAR(50) DEFAULT 'default',
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, recipe_id, collection_name)
);

-- 5. Tabel Cooking History
CREATE TABLE IF NOT EXISTS cooking_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    recipe_id UUID REFERENCES recipes(id) ON DELETE CASCADE,
    recipe_source VARCHAR(50),
    recipe_source_id VARCHAR(120),
    recipe_title VARCHAR(200),
    recipe_image_url TEXT,
    recipe_category VARCHAR(100),
    recipe_cuisine VARCHAR(100),
    rating INT CHECK (rating >= 1 AND rating <= 5),
    review TEXT,
    cooking_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    modified_ingredients JSONB,
    notes TEXT,
    recipe_payload JSONB DEFAULT '{}'::jsonb
);

-- 6. Tabel Shopping Lists
CREATE TABLE IF NOT EXISTS shopping_lists (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(100) DEFAULT 'My Shopping List',
    items JSONB NOT NULL,
    total_estimated_price DECIMAL(10,2),
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 6b. Tabel Shopping List Recipes (serving scaler source)
CREATE TABLE IF NOT EXISTS shopping_list_recipes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source VARCHAR(50) NOT NULL,
    source_id VARCHAR(120) NOT NULL,
    recipe_title VARCHAR(200) NOT NULL,
    recipe_image_url TEXT,
    recipe_category VARCHAR(100),
    base_servings NUMERIC(10,2) NOT NULL DEFAULT 1,
    desired_servings NUMERIC(10,2) NOT NULL DEFAULT 1,
    estimated_price NUMERIC(12,2) NOT NULL DEFAULT 0,
    recipe_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
    scaled_ingredients JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, source, source_id)
);

-- 6c. Tabel Shopping List Item States (checkbox checked/unchecked)
CREATE TABLE IF NOT EXISTS shopping_list_item_states (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_key VARCHAR(220) NOT NULL,
    item_name VARCHAR(200) NOT NULL,
    unit VARCHAR(100) DEFAULT '',
    category VARCHAR(50) DEFAULT 'lainnya',
    checked BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, item_key)
);

-- 6d. Tabel Shopping List Manual Items
CREATE TABLE IF NOT EXISTS shopping_list_manual_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_name VARCHAR(200) NOT NULL,
    quantity VARCHAR(50) DEFAULT '',
    unit VARCHAR(100) DEFAULT '',
    category VARCHAR(50) DEFAULT 'lainnya',
    estimated_price NUMERIC(12,2) NOT NULL DEFAULT 0,
    checked BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 7. Tabel Community Reports
CREATE TABLE IF NOT EXISTS community_reports (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reporter_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    reported_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    target_type VARCHAR(20) NOT NULL CHECK (target_type IN ('post', 'user', 'comment')),
    target_id UUID NOT NULL,
    post_id UUID REFERENCES community_posts(id) ON DELETE CASCADE,
    reason VARCHAR(100) NOT NULL,
    details TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewing', 'resolved', 'dismissed')),
    admin_note TEXT,
    resolver_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    resolved_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 7. Tabel Community Posts
CREATE TABLE IF NOT EXISTS community_posts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    recipe_id UUID REFERENCES recipes(id) ON DELETE CASCADE,
    title VARCHAR(200) NOT NULL,
    content TEXT,
    image_url TEXT,
    likes_count INT DEFAULT 0,
    comments_count INT DEFAULT 0,
    shares_count INT DEFAULT 0,
    is_trending BOOLEAN DEFAULT false,
    is_deleted BOOLEAN DEFAULT false,
    deleted_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 8. Tabel Comments
CREATE TABLE IF NOT EXISTS comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    post_id UUID REFERENCES community_posts(id) ON DELETE CASCADE,
    parent_comment_id UUID REFERENCES comments(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    likes_count INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 8b. Tabel Community Post Likes
CREATE TABLE IF NOT EXISTS community_post_likes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    post_id UUID REFERENCES community_posts(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, post_id)
);

-- 9. Tabel AI Generated Recipes
CREATE TABLE IF NOT EXISTS ai_generated_recipes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    prompt TEXT NOT NULL,
    generated_recipe JSONB NOT NULL,
    user_feedback INT,
    was_used BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 10. Tabel AI Chat Sessions
CREATE TABLE IF NOT EXISTS ai_chat_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id VARCHAR(128) NOT NULL UNIQUE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(200),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 11. Tabel AI Chat Messages
CREATE TABLE IF NOT EXISTS ai_chat_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id VARCHAR(128) NOT NULL,
    role VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 12b. Tabel Admin Challenges
CREATE TABLE IF NOT EXISTS admin_challenges (
    scope VARCHAR(20) PRIMARY KEY,
    recipe_id TEXT NOT NULL,
    recipe_source VARCHAR(50) NOT NULL,
    recipe_title VARCHAR(200) NOT NULL,
    recipe_image_url TEXT,
    recipe_category VARCHAR(100),
    recipe_cuisine VARCHAR(100),
    recipe_cooking_time INT,
    recipe_likes_count INT DEFAULT 0,
    recipe_views_count INT DEFAULT 0,
    recipe_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 12. Tabel User Ingredients Inventory
CREATE TABLE IF NOT EXISTS user_ingredients (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    ingredient_name VARCHAR(100) NOT NULL,
    quantity VARCHAR(50),
    expiry_date DATE,
    added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, ingredient_name)
);

-- 13. Tabel Mood Recommendations
CREATE TABLE IF NOT EXISTS mood_recommendations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    mood VARCHAR(30) NOT NULL,
    recommended_recipe_id UUID REFERENCES recipes(id),
    was_helpful BOOLEAN,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================
-- INDEXES
-- =====================================================
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_recipes_title ON recipes(title);
CREATE INDEX IF NOT EXISTS idx_recipes_category ON recipes(category);
CREATE INDEX IF NOT EXISTS idx_recipes_tags ON recipes USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_recipe_media_sources_active_sort ON recipe_media_sources(is_active, sort_order, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recipe_media_sources_category ON recipe_media_sources(category);
CREATE INDEX IF NOT EXISTS idx_recipe_media_sources_cuisine ON recipe_media_sources(cuisine);
CREATE INDEX IF NOT EXISTS idx_recipe_media_sources_tags ON recipe_media_sources USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_user_favorites_user ON user_favorites(user_id);
CREATE INDEX IF NOT EXISTS idx_cooking_history_user ON cooking_history(user_id);
CREATE INDEX IF NOT EXISTS idx_shopping_list_recipes_user ON shopping_list_recipes(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_shopping_list_item_states_user ON shopping_list_item_states(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_shopping_list_manual_items_user ON shopping_list_manual_items(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_community_post_likes_user_post ON community_post_likes(user_id, post_id);
CREATE INDEX IF NOT EXISTS idx_ai_chat_sessions_session ON ai_chat_sessions(session_id);
CREATE INDEX IF NOT EXISTS idx_ai_chat_messages_session_created ON ai_chat_messages(session_id, created_at);

-- =====================================================
-- SAMPLE DATA (untuk testing)
-- =====================================================

-- Insert sample user (password: "test123" nanti di-hash di app)
INSERT INTO users (username, email, password_hash, role, avatar_url, dietary_preferences, allergies, budget_per_meal)
VALUES 
('annisakost', 'annisa@example.com', '$2b$10$dummyhash123', 'user', 'https://ui-avatars.com/api/?name=Annisa', '["vegetarian"]', '["peanut"]', 15000),
('budi_kost', 'budi@example.com', '$2b$10$dummyhash456', 'user', 'https://ui-avatars.com/api/?name=Budi', '[]', '[]', 10000),
('adminrecipe', 'admin@recipeplanner.local', '$2b$10$FWQc/haZf.tcUZeF.siNi.qQAOR8WaJxjnbU/CIpEAxIRiZYPDILO', 'admin', 'https://ui-avatars.com/api/?name=Admin', '[]', '[]', 0)
ON CONFLICT (email) DO NOTHING;

-- Insert sample recipes
INSERT INTO recipes (title, description, image_url, cooking_time, servings, difficulty, ingredients, steps, calories, category, cuisine, tags, estimated_price, price_rating, is_approved)
VALUES 
(
    'Indomie Goreng Special', 
    'Indomie goreng dengan topping telur mata sapi dan sosis', 
    'https://images.unsplash.com/photo-1563379091339-03b21dd4dfa3',
    10, 1, 'easy',
    '[{"name":"Indomie Goreng","amount":"1","unit":"bungkus"},{"name":"Telur","amount":"1","unit":"butir"},{"name":"Sosis","amount":"1","unit":"buah"}]',
    '[{"step":1,"instruction":"Rebus mie setengah matang"},{"step":2,"instruction":"Tumis bumbu dan telur"},{"step":3,"instruction":"Campur mie dengan bumbu"},{"step":4,"instruction":"Tambahkan topping"}]',
    450, 'main course', 'indonesian', '["murah","cepat","enak"]', 8000, 'cheap', true
),
(
    'Nasi Goreng Kampung', 
    'Nasi goreng sederhana rasa kampung', 
    'https://images.unsplash.com/photo-1512058564366-18510be2db19',
    15, 2, 'easy',
    '[{"name":"Nasi putih","amount":"2","porsi":"porsi"},{"name":"Bawang merah","amount":"3","unit":"siung"},{"name":"Kecap manis","amount":"2","unit":"sdm"}]',
    '[{"step":1,"instruction":"Haluskan bawang"},{"step":2,"instruction":"Tumis hingga harum"},{"step":3,"instruction":"Masukkan nasi dan kecap"},{"step":4,"instruction":"Aduk rata dan sajikan"}]',
    520, 'main course', 'indonesian', '["murah","nusantara"]', 12000, 'cheap', true
),
(
    'Mie Ayam Jamur', 
    'Mie ayam dengan topping jamur dan ayam cincang', 
    'https://images.unsplash.com/photo-1552611052-33e04de081de',
    25, 1, 'medium',
    '[{"name":"Mie","amount":"1","unit":"bungkus"},{"name":"Dada ayam","amount":"100","unit":"gram"},{"name":"Jamur","amount":"50","unit":"gram"}]',
    '[{"step":1,"instruction":"Rebus mie"},{"step":2,"instruction":"Tumis ayam dan jamur"},{"step":3,"instruction":"Sajikan dengan kuah"}]',
    580, 'main course', 'chinese', '["enak","berat"]', 15000, 'medium', true
)
ON CONFLICT DO NOTHING;

-- Insert sample favorites
INSERT INTO user_favorites (user_id, recipe_id, collection_name)
SELECT u.id, r.id, 'favorites'
FROM users u, recipes r
WHERE u.username = 'annisakost' AND r.title = 'Indomie Goreng Special'
ON CONFLICT DO NOTHING;

-- Insert sample cooking history
INSERT INTO cooking_history (user_id, recipe_id, rating, review)
SELECT u.id, r.id, 5, 'Enak banget! Cocok untuk anak kost!'
FROM users u, recipes r
WHERE u.username = 'annisakost' AND r.title = 'Indomie Goreng Special'
ON CONFLICT DO NOTHING;
