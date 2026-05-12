const express = require("express");

const router = express.Router();

router.get("/", (req, res) => {
  res.render("landing", {
    title: "ResepKu",
  });
});

router.get("/home", (req, res) => {
  res.render("home", {
    title: "ResepKu Home",
  });
});
module.exports = router;
