/**
 * Side-effect module: install global console redaction before ANY dependency
 * gets a chance to log. server.js imports this as its very first import, so
 * ESM evaluates it before the openai SDK / express module bodies run.
 */
import { installConsoleRedaction } from './consoleRedaction.js';
import { registerSecretValues, secretValuesFromEnv } from './llmErrors.js';

// The keys this process holds are redacted by value, whatever they look like (a model provider's key need
// not start with "sk-"): known before anything can log.
registerSecretValues(secretValuesFromEnv(process.env));
installConsoleRedaction(console);
