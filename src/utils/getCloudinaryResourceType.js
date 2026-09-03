const getCloudinaryResourceType = (mimetype) => {
  if (mimetype.startsWith("image/")) {
    return "image";
  }

  return "video";
};

module.exports = getCloudinaryResourceType;
