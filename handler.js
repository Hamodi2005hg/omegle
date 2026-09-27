// Serverless Framework Handler for Express & Signaling Server APIs
const serverless = require('serverless-http');
const app = require('./server');

// Wrap Express app with serverless-http
const handler = serverless(app, {
  binary: ['image/*', 'font/*', 'video/*', 'audio/*']
});

module.exports.handler = async (event, context) => {
  return await handler(event, context);
};
