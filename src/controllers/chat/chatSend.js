// const { User } = require("../../models");
// const estimateCost = require("../../utils");

// const NEGATIVE_LIMIT = -1000;

// const chatSend = async (req, res) => {
//   const { modelId, estimatedTokens } = req.body;
//   const userId = req.user.id;

//   if (!modelId || !estimatedTokens) {
//     return res.status(400).json({
//       error: "modelId and estimatedTokens required",
//     });
//   }

//   // 1️⃣ Получаем пользователя
//   const user = await User.findById(userId).lean();
//   if (!user) {
//     return res.status(401).json({ error: "User not found" });
//   }

//   // 2️⃣ Проверяем модель + считаем estimate
//   let estimate;
//   try {
//     estimate = await estimateCost(modelId, estimatedTokens);
//   } catch (e) {
//     return res.status(400).json({ error: e.message });
//   }

//   const projectedBalance = user.appTokens - estimate.appTokens;

//   // 3️⃣ Проверка лимита
//   if (projectedBalance < NEGATIVE_LIMIT) {
//     return res.status(402).json({
//       error: "Insufficient balance",
//       balance: user.appTokens,
//       required: estimate.appTokens,
//       limit: NEGATIVE_LIMIT,
//     });
//   }

//   // 4️⃣ Всё ок — разрешаем запуск stream
//   res.json({
//     ok: true,
//     modelId,
//     estimate,
//     balanceAfter: projectedBalance,
//   });
// };

// module.exports = chatSend;
