// Applied before pino transports (including pino-pretty) serialize HTTP logs.
module.exports = {
  paths: [
    'req.headers.authorization', 'req.headers.cookie', 'req.headers["proxy-authorization"]',
    'req.headers["x-api-key"]', 'req.headers.Authorization', 'req.headers.Cookie',
    'res.headers["set-cookie"]', 'res.headers["Set-Cookie"]',
    'headers.authorization', 'headers.cookie', 'headers["set-cookie"]',
    'err.headers.authorization', 'err.headers.cookie', 'err.headers["set-cookie"]'
  ],
  censor: '[REDACTED]'
};
