const { Project, ChatConversation } = require('../../models');
const store = require('./store');
const deleteChat = require('./deleteConversationFiles');
const { fail } = require('./validation');
module.exports = async (user, id, deleteChats, deleteFiles) => {
  if (!store.idOK(String(id))) throw fail('PROJECT_NOT_FOUND', 404);
  if (deleteFiles && !deleteChats) throw fail('INVALID_DELETE_OPTIONS', 400);
  return store.transaction(async session => {
    const project = await Project.findOneAndUpdate({ _id:id, user }, {$set:{deleted:new Date()}}, {new:true,session});
    if (!project) throw fail('PROJECT_NOT_FOUND',404);
    const chats = await ChatConversation.find({user,project:id}).select('_id').session(session).lean();
    let deletedFiles = 0;
    if (deleteChats) {
      for (const chat of chats) deletedFiles += (await deleteChat(user,String(chat._id),deleteFiles,session)).deletedFiles;
    }
    await ChatConversation.updateMany({user,project:id},{$set:{project:null,projectPinnedAt:null}},{session});
    return {success:true,deletedChatIds:deleteChats?chats.map(c=>String(c._id)):[],deletedFiles};
  });
};
