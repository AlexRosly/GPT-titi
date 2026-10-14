module.exports = async () => {
  throw Object.assign(new Error("Use Chat Delivery V2"), { code: "CHAT_V2_REQUIRED", status: 410 });
};
