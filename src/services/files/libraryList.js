const File = require('../../models/managedFile');
const Quota = require('../../models/fileQuota');
const { fail } = require('./validation');
const { dto } = require('./store');
const config = require('./config');

const sorts = new Map([
  ['newest', ['_id', -1]], ['oldest', ['_id', 1]],
  ['name', ['originalName', 1]], ['size', ['size', -1]],
]);
const categories = new Map([
  ['Images', 'png|jpg|jpeg|webp|svg'], ['Documents', 'pdf|docx'],
  ['Spreadsheets', 'csv|tsv|xlsx'], ['Archives', 'zip'], ['Presentations', 'pptx'],
]);
const projection = 'originalName mimetype size source status version createdAt retention expiresAt';
const invalid = () => fail('INVALID_ENVELOPE', 400);
const badCursor = () => fail('INVALID_CURSOR', 400);
const encode = (sort, id, key) => 'v2.' + Buffer.from(JSON.stringify([sort, String(id), key])).toString('base64url');
function decode(input, sort, field) {
  if (typeof input !== 'string' || input.length > 8192 || !/^v2\.[\w-]+$/.test(input)) throw badCursor();
  let data;
  try { data = JSON.parse(Buffer.from(input.slice(3), 'base64url').toString('utf8')); } catch { throw badCursor(); }
  if (!Array.isArray(data) || data.length !== 3 || data[0] !== sort ||
      typeof data[1] !== 'string' || !/^[a-f\d]{24}$/i.test(data[1])) throw badCursor();
  const [, id, key] = data;
  if (field === 'size' ? !Number.isSafeInteger(key) || key < 0 :
      field === 'originalName' ? typeof key !== 'string' : key !== null) throw badCursor();
  return { id, key };
}

async function page(user, query) {
  const { sort = 'newest', source = 'all', category = 'all', q = '', limit = '40', cursor } = query;
  if (!sorts.has(sort) || !['all','upload','generated'].includes(source) ||
      !(category === 'all' || category === 'Text & code' || categories.has(category)) ||
      typeof q !== 'string' || q.length > 256 || q.includes('\0') || typeof limit !== 'string' ||
      !/^\d{1,3}$/.test(limit) || +limit < 1 || +limit > 100) throw invalid();
  const [field, direction] = sorts.get(sort);
  const filter = { user, status: 'ready', retention: { $ne: 'temporary' }, expiresAt: null };
  if (source !== 'all') filter.source = source;
  const conditions = [];
  if (q) conditions.push({ originalName: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') });
  if (category !== 'all') {
    const other = category === 'Text & code';
    const ext = other ? [...categories.values()].join('|') : categories.get(category);
    const suffix = new RegExp('\\.(?:' + ext + ')$', 'i');
    conditions.push({ originalName: other ? { $not: suffix } : suffix });
  }
  if (cursor !== undefined) {
    const { id, key } = decode(cursor, sort, field);
    const op = direction === 1 ? '$gt' : '$lt';
    if (field === '_id') filter._id = { [op]: id };
    else conditions.push({ $or: [{ [field]: { [op]: key } }, { [field]: key, _id: { [op]: id } }] });
  }
  if (conditions.length) filter.$and = conditions;
  const scan = File.find(filter).select(projection).sort({ [field]: direction, _id: direction }).limit(+limit + 1).maxTimeMS(12000);
  if (sort === 'name') scan.collation({ locale: 'en', strength: 2 });
  const [found, usage] = await Promise.all([scan.lean(), Quota.findById(user).lean()]);
  const files = found.slice(0, +limit), last = files.at(-1);
  return { listVersion: 2, files: files.map(dto),
    nextCursor: found.length > files.length ? encode(sort, last._id, field === '_id' ? null : last[field]) : null,
    quota: { bytes: usage?.bytes ?? 0, count: usage?.count ?? 0, maxBytes: config.quotaBytes(), maxCount: null } };
}
module.exports = { page };
