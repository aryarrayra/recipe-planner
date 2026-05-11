const path = require("path");
const express = require("express");
const session = require("express-session");
const dotenv = require("dotenv");

const indexRoutes = require("./routes/index");
const recipeRoutes = require("./routes/recipes");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

app.use(
  session({
    secret: process.env.SESSION_SECRET || "secret-key",
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false },
  })
);

app.use("/api/recipes", recipeRoutes);
app.use("/", indexRoutes);

app.listen(PORT, () => {
  console.log(`Recipe Planner running on http://localhost:${PORT}`);
  console.log(
    `Database: ${process.env.DATABASE_URL ? "Configured" : "Not configured"}`
  );
});
