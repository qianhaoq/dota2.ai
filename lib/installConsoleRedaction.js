/**
 * Side-effect module: install global console redaction before ANY dependency
 * gets a chance to log. server.js imports this as its very first import, so
 * ESM evaluates it before the openai SDK / express module bodies run.
 */
import { installConsoleRedaction } from './consoleRedaction.js';

installConsoleRedaction(console);
