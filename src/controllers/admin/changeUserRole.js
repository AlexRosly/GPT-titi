const { User } = require("../../models");

const ALLOWED_ROLES = ["user", "admin", "moderator", "support"];

const changeUserRole = async (req, res) => {
  try {
    const targetUserId = req.params.id;
    const { role } = req.body;
    const adminId = req.user.id;

    /* 1️⃣ Проверка роли */
    if (!ALLOWED_ROLES.includes(role)) {
      return res.status(400).json({
        error: "Invalid role",
        allowed: ALLOWED_ROLES,
      });
    }

    /* 2️⃣ Запрет менять роль самому себе */
    if (targetUserId === adminId) {
      return res.status(403).json({
        error: "You cannot change your own role",
      });
    }

    /* 3️⃣ Находим пользователя */
    const user = await User.findById(targetUserId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    /* 4️⃣ Меняем роль */
    const prevRole = user.role;
    user.role = role;
    await user.save();

    res.json({
      success: true,
      user: {
        id: user._id,
        email: user.email,
        role: user.role,
      },
      changed: {
        from: prevRole,
        to: role,
      },
    });
  } catch (error) {
    console.error("Error in controller changeUserRole:", error);
    res.status(500).json({
      status: 500,
      message: "Internal server error",
    });
  }
};

module.exports = changeUserRole;
