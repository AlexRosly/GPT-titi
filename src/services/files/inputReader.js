// Shared dispatch keeps acceptance, history reservation and provider input identical.
const text = require('./textInput');
const office = require('./officeInput');
const pdf = require('./pdfInput');
const ocr = require('./ocrInput');
const reader = (file, model) => ocr.eligible(file, model) ? ocr : text.supported(file) ? text : office.supported(file) ? office : pdf.supported(file) ? pdf : null;
module.exports = {
  supported: (file, model) => Boolean(reader(file, model)),
  readPart: (user, file, options) => reader(file, options?.model).readPart(user, file, options),
};
