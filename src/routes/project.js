const { projects: ctrl } = require("../controllers");
const { auth } = require("../middlewares");
// const { claimLimiter } = require("../utils");

const express = require("express");
const router = express.Router();

router.post("/", auth, ctrl.createProject); // Создать проект POST /projects
router.get("/", auth, ctrl.getProjects); // Все проекты пользователя GET /projects
router.get("/:id", auth, ctrl.getProjectById); // Информация о проекте GET /projects/:id
router.post("/:projectId/conversations", auth, ctrl.addConversationsToProject);

router.patch("/:id", auth, ctrl.updateProject); // Переименовать Изменить цвет Изменить описание Изменить иконку PATCH /projects/:id

router.delete(
  "/:projectId/conversations/:conversationId",
  auth,
  ctrl.removeConversationFromProject,
);
router.delete("/:id", auth, ctrl.deleteProject); //Удалить проект DELETE /projects/:id

// POST /projects/:projectId/conversations

module.exports = router;
