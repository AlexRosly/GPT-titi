const router = require("express").Router();
const auth = require("../middlewares/auth");
const adminOnly = require("../middlewares/adminOnly");
const { admin: ctrl } = require("../controllers");

router.get("/users", auth, adminOnly, ctrl.getUsers);
router.get("/payments", auth, adminOnly, ctrl.getPayments);
router.get("/users/:id/billing", auth, adminOnly, ctrl.getUserBilling);
router.post("/users/:id/block", auth, adminOnly, ctrl.blockUser);
router.get("/analytics/models", auth, adminOnly, ctrl.getModelAnalytics);

module.exports = router;
