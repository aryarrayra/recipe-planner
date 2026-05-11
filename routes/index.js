const express = require("express");

const router = express.Router();

router.get("/", (req, res) => {
  res.render("landing", {
    title: "Recipe Planner Login",
  });
});

router.get("/home", (req, res) => {
  res.render("home", {
    title: "Recipe Planner Home",
  });
});

module.exports = router;
