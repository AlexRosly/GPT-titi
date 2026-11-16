const deleteProject = async (req, res) => {
  try {
    const query = req.query || {};
    for (const key of ['deleteChats','deleteFiles']) {
      if (query[key] !== undefined && !['true','false'].includes(query[key]))
        return res.status(400).json({error:'INVALID_DELETE_OPTIONS',message:'Invalid deletion options.'});
    }
    const result = await require('../../services/files/deleteProjectFiles')(
      req.user._id, req.params.id, query.deleteChats === 'true', query.deleteFiles === 'true');
    res.json(result);
  } catch (err) {
    if (err.fileError) return res.status(err.status).json({error:err.fileError,message:err.fileError === 'CHAT_BUSY_STOP_BEFORE_DELETE' ? 'Stop active responses in this project before deleting its chats and files.' : err.fileError === 'INVALID_DELETE_OPTIONS' ? 'Files cannot be deleted while keeping project chats.' : 'Project not found.'});
    console.error('Error in controller deleteProject:',err);
    res.status(500).json({message:'Cannot delete project'});
  }
};
module.exports = deleteProject;
