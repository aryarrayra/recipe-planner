const express = require("express");

const router = express.Router();

router.get("/", (req, res) => {
  res.render("landing", {
    title: "Recipe Planner Login",
  });
});

router.get("/register", (req, res) => {
  res.render("register", {
    title: "Recipe Planner Register",
  });
});

router.post("/login", (req, res) => {
  res.redirect("/");
});

router.post("/register", (req, res) => {
  res.redirect("/register");
});

module.exports = router;
