import User from "../models/user.model.js";

export const userRepository = {
  findByGoogleId: (googleId) => User.findOne({ googleId }),
  findById: (id) => User.findById(id),
  create: (data) => User.create(data),
};
