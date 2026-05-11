const path = require('path');
const express = require('express');
const session = require('express-session');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(
    session({
        secret: process.env.SESSION_SECRET || 'secret-key',
        resave: false,
        saveUninitialized: true,
        cookie: { secure: false }
    })
);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

const recipeRoutes = require('./routes/recipes');
app.use('/api/recipes', recipeRoutes);

app.use('/', require('./routes/auth'));
app.use('/', require('./routes/index'));
app.use('/', require('./routes/ai'));

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Database: ${process.env.DATABASE_URL ? 'Connected to Neon' : 'No DB'}`);
});
