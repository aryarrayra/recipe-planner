const express = require('express');
const session = require('express-session');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Session
app.use(session({
    secret: process.env.SESSION_SECRET || 'secret-key',
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false }
}));

// Set EJS
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Routes API
const recipeRoutes = require('./routes/recipes');
app.use('/api/recipes', recipeRoutes);

// Route untuk render halaman
app.get('/', (req, res) => {
    res.render('landing', { title: 'AI Recipe Planner' });
});

app.get('/home', (req, res) => {
    res.render('home', { title: 'Home - AI Recipe Planner' });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📡 Database: ${process.env.DATABASE_URL ? 'Connected to Neon' : 'No DB'}`);
});