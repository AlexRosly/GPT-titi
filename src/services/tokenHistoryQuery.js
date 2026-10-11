const { createHash } = require("node:crypto");
const mongoose = require("mongoose");

class HistoryError extends Error {
  constructor(message) { super(message); this.status = 400; this.code = "INVALID_HISTORY_QUERY"; }
}
const scalar = (value, fallback = "") => {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || value.length > 2048) throw new HistoryError("Invalid query value.");
  return value;
};
const day = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number(value.slice(0, 4)) < 1970 ||
      !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) ||
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new HistoryError("Dates must be valid YYYY-MM-DD values from 1970 onward.");
  }
  return value;
};
const nextDay = (value) => new Date(Date.parse(`${day(value)}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
const formatter = (timeZone) => new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
const localDate = (at, timeZone) => {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(at).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};
// Locate the first instant of a local date rather than adding 24h. This handles
// 23/25-hour DST days and midnight transitions without another date dependency.
const dayStart = (value, timeZone) => {
  const target = Date.parse(`${day(value)}T00:00:00Z`);
  const fmt = formatter(timeZone);
  const dateAt = (ms) => {
    const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
    return `${p.year}-${p.month}-${p.day}`;
  };
  let low = target - 48 * 3600000, high = target + 48 * 3600000;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (dateAt(middle) < value) low = middle + 1;
    else high = middle;
  }
  return new Date(low);
};
const parseQuery = (query = {}, overrides = {}) => {
  const q = { ...query, ...overrides };
  const mode = scalar(q.mode, "general");
  const type = scalar(q.type, "all");
  const timeZone = scalar(q.timeZone, "UTC");
  if (!["general", "detailed"].includes(mode)) throw new HistoryError("mode must be general or detailed.");
  if (!["all", "purchase", "received", "sent", "bonus", "usage", "refund", "adjustment", "nonusage"].includes(type)) throw new HistoryError("Invalid activity type.");
  try { formatter(timeZone).format(new Date()); } catch { throw new HistoryError("Invalid IANA time zone."); }
  let from = scalar(q.from), to = scalar(q.to);
  if (from) day(from);
  if (to) day(to);
  const selectedDay = scalar(q.day);
  if (selectedDay) { day(selectedDay); from = to = selectedDay; }
  if (from && to && from > to) throw new HistoryError("from must not be after to.");
  const limitText = scalar(q.limit, mode === "general" ? "7" : "50");
  const maximum = mode === "general" ? 14 : 100;
  if (!/^\d+$/.test(limitText) || Number(limitText) < 1 || Number(limitText) > maximum) throw new HistoryError(`limit must be between 1 and ${maximum}.`);
  const createdAt = {};
  if (from) createdAt.$gte = dayStart(from, timeZone);
  if (to) createdAt.$lt = dayStart(nextDay(to), timeZone);
  return { mode, type, timeZone, from, to, limit: Number(limitText), cursor: scalar(q.cursor), createdAt };
};
const scope = (userId, options) => createHash("sha256").update(JSON.stringify([
  String(userId), options.mode, options.type, options.from, options.to, options.timeZone,
])).digest("hex");
const encodeCursor = (userId, options, position) => Buffer.from(JSON.stringify({ scope: scope(userId, options), ...position })).toString("base64url");
const decodeCursor = (userId, options) => {
  if (!options.cursor) return null;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(options.cursor)) throw new Error();
    const data = JSON.parse(Buffer.from(options.cursor, "base64url").toString());
    if (data.scope !== scope(userId, options)) throw new Error();
    if (options.mode === "general") { day(data.day); return { day: data.day }; }
    if (typeof data.at !== "string" || !mongoose.isValidObjectId(data.id) ||
      !/^\d{4}-\d{2}-\d{2}T/.test(data.at) || new Date(data.at).toISOString() !== data.at) throw new Error();
    return { at: new Date(data.at), id: new mongoose.Types.ObjectId(data.id) };
  } catch { throw new HistoryError("Invalid cursor or cursor belongs to different filters/account."); }
};
module.exports = { HistoryError, parseQuery, day, nextDay, dayStart, localDate, encodeCursor, decodeCursor };
