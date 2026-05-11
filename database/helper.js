const pool = require('../config/db');

class Database {
    // Query helper
    static async query(text, params) {
        const start = Date.now();
        const res = await pool.query(text, params);
        const duration = Date.now() - start;
        console.log('Executed query:', { text, duration, rows: res.rowCount });
        return res;
    }

    // User methods
    static async getUserById(id) {
        const res = await this.query('SELECT * FROM users WHERE id = $1', [id]);
        return res.rows[0];
    }

    static async getUserByEmail(email) {
        const res = await this.query('SELECT * FROM users WHERE email = $1', [email]);
        return res.rows[0];
    }

    static async createUser(userData) {
        const { username, email, password_hash, avatar_url } = userData;
        const res = await this.query(
            'INSERT INTO users (username, email, password_hash, avatar_url) VALUES ($1, $2, $3, $4) RETURNING *',
            [username, email, password_hash, avatar_url]
        );
        return res.rows[0];
    }

    // Recipe methods
    static async getAllRecipes(limit = 20, offset = 0) {
        const res = await this.query(
            'SELECT * FROM recipes WHERE is_approved = true ORDER BY created_at DESC LIMIT $1 OFFSET $2',
            [limit, offset]
        );
        return res.rows;
    }

    static async searchRecipesByIngredients(ingredients) {
        // Search recipes that contain any of the ingredients
        const res = await this.query(
            `SELECT * FROM recipes 
             WHERE ingredients::text ILIKE ANY($1) 
             AND is_approved = true 
             LIMIT 20`,
            [ingredients.map(ing => `%${ing}%`)]
        );
        return res.rows;
    }

    static async getRecipesByBudget(maxPrice) {
        const res = await this.query(
            'SELECT * FROM recipes WHERE estimated_price <= $1 AND is_approved = true ORDER BY estimated_price ASC',
            [maxPrice]
        );
        return res.rows;
    }

    static async getRecipesByMood(mood) {
        // Map mood to recipe tags
        const moodMap = {
            'sad': ['comfort', 'sweet'],
            'happy': ['celebratory', 'dessert'],
            'tired': ['simple', 'quick', 'coffee'],
            'stressed': ['comfort', 'easy']
        };
        
        const tags = moodMap[mood] || ['simple'];
        const res = await this.query(
            'SELECT * FROM recipes WHERE tags && $1 AND is_approved = true LIMIT 10',
            [tags]
        );
        return res.rows;
    }

    static async saveFavorite(userId, recipeId, collection = 'default') {
        const res = await this.query(
            'INSERT INTO user_favorites (user_id, recipe_id, collection_name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING *',
            [userId, recipeId, collection]
        );
        
        // Update user stats
        if (res.rows[0]) {
            await this.query(
                'UPDATE users SET total_saved_recipes = total_saved_recipes + 1 WHERE id = $1',
                [userId]
            );
        }
        return res.rows[0];
    }

    static async addToCookingHistory(userId, recipeId, rating, review) {
        const res = await this.query(
            'INSERT INTO cooking_history (user_id, recipe_id, rating, review) VALUES ($1, $2, $3, $4) RETURNING *',
            [userId, recipeId, rating, review]
        );
        
        // Update user stats
        await this.query(
            'UPDATE users SET total_recipes_cooked = total_recipes_cooked + 1 WHERE id = $1',
            [userId]
        );
        
        return res.rows[0];
    }

    static async getShoppingList(userId) {
        const res = await this.query(
            'SELECT * FROM shopping_lists WHERE user_id = $1 AND is_active = true ORDER BY created_at DESC LIMIT 1',
            [userId]
        );
        return res.rows[0];
    }

    static async updateShoppingList(userId, items) {
        const res = await this.query(
            `INSERT INTO shopping_lists (user_id, items, updated_at) 
             VALUES ($1, $2, CURRENT_TIMESTAMP) 
             ON CONFLICT (user_id, is_active) 
             DO UPDATE SET items = $2, updated_at = CURRENT_TIMESTAMP 
             RETURNING *`,
            [userId, JSON.stringify(items)]
        );
        return res.rows[0];
    }

    static async getTrendingRecipes() {
        const res = await this.query(
            `SELECT * FROM recipes 
             WHERE is_approved = true 
             ORDER BY likes_count DESC, views_count DESC 
             LIMIT 10`
        );
        return res.rows;
    }

    static async logAIRecommendation(userId, prompt, generatedRecipe, feedback = null) {
        const res = await this.query(
            'INSERT INTO ai_generated_recipes (user_id, prompt, generated_recipe, user_feedback) VALUES ($1, $2, $3, $4) RETURNING *',
            [userId, prompt, JSON.stringify(generatedRecipe), feedback]
        );
        return res.rows[0];
    }
}

module.exports = Database;