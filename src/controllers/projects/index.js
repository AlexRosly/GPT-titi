const createProject = require("./createProject");
const getProjects = require("./getProjects");
const getProjectById = require("./getProjectById");
const updateProject = require("./updateProject");
const deleteProject = require("./deleteProject");
const addConversationsToProject = require("./addConversationsToProject");
const removeConversationFromProject = require("./removeConversationFromProject");

module.exports = {
  createProject,
  getProjects,
  getProjectById,
  updateProject,
  deleteProject,
  addConversationsToProject,
  removeConversationFromProject,
};
