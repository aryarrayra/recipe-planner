const express = require("express");

const router = express.Router();

router.get("/", (req, res) => {
  res.render("landing", {
    title: "ResepKu",
  });
});

router.get("/login", (req, res) => {
  res.render("login", {
    title: "ResepKu Login",
  });
});

router.get("/home", (req, res) => {
  res.render("home", {
    title: "ResepKu Home",
  });
});

router.get("/register", (req, res) => {
  res.render("register", {
    title: "ResepKu Register",
  });
});

router.post("/login", (req, res) => {
  res.redirect("/login");
});

router.post("/register", (req, res) => {
  res.redirect("/register");
});
module.exports = router;
