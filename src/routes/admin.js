const router = require("express").Router();
const { auth } = require("../middlewares");
const adminOnly = require("../middlewares/adminOnly");
const { admin: ctrl } = require("../controllers");

router.get("/models", auth, adminOnly, ctrl.getModels); //
router.get("/users", auth, adminOnly, ctrl.getUsers); //
router.get("/payments", auth, adminOnly, ctrl.getPayments); //
router.get("/users/:id/billing", auth, adminOnly, ctrl.getUserBilling); //
router.get("/analytics/models", auth, adminOnly, ctrl.getModelAnalytics);
router.post("/users/:id/block", auth, adminOnly, ctrl.blockUser); //
router.post("/create-models", auth, adminOnly, ctrl.createModel); //

module.exports = router;
